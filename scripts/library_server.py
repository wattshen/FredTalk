"""Loopback-only portable catalog server; never serves arbitrary repository files."""
import argparse
import copy
from datetime import datetime
import hashlib
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
import json
import mimetypes
import os
from pathlib import Path
import re
import secrets
import threading
import time
from urllib.parse import parse_qs, urlsplit, unquote

ROOT = Path(__file__).resolve().parents[1]
LOCK = threading.Lock()
INTAKE_ROOT = Path(os.environ.get('FREDTALK_INTAKE_ROOT') or r'D:\output\fredtalk-intake')
MAX_INTAKE_UPLOAD_BYTES = 4 * 1024 ** 3

def read(name):
    return json.loads((ROOT / 'library' / name).read_text())


def intake_slug(value):
    value = re.sub(r'[^A-Za-z0-9\u4e00-\u9fff]+', '-', str(value or '').strip()).strip('-')
    return value[:40].lower() or 'project'


def intake_project_dir(project_id, require_exists=True):
    if project_id in ('.', '..') or not re.fullmatch(r'[A-Za-z0-9\u4e00-\u9fff._-]+', project_id or ''):
        raise ValueError('无效的项目 ID')
    project_dir = (INTAKE_ROOT / project_id).resolve()
    if not project_dir.is_relative_to(INTAKE_ROOT.resolve()):
        raise ValueError('项目目录越界')
    if require_exists and not project_dir.is_dir():
        raise ValueError('项目不存在，请先创建项目')
    return project_dir


def intake_relative_path(value):
    value = unquote(str(value or '')).replace('\\', '/').strip()
    if not value or value.startswith('/') or re.match(r'^[A-Za-z]:', value):
        raise ValueError('无效的文件路径')
    parts = [part for part in value.split('/') if part not in ('', '.')]
    if not parts or any(part == '..' or '\x00' in part for part in parts):
        raise ValueError('无效的文件路径')
    return '/'.join(parts)


def intake_file_path(project_dir, relative_path):
    relative_path = intake_relative_path(relative_path)
    path = (project_dir / Path(*relative_path.split('/'))).resolve()
    if not path.is_relative_to(project_dir.resolve()) or path.is_symlink():
        raise ValueError('文件路径越界')
    return path


def build_handoff(project_id, project_dir, data, script_path, audio_path, subtitles_path, materials):
    scope_labels = {
        'suggestions': '逐段图文建议',
        'keyframes': '逐段建议 + 真实关键帧',
        'full': '完整视频',
    }
    requirements = data.get('requirements') or {}
    lines = [
        '# FredTalk 制作交接单',
        '',
        '## 项目',
        f"- 项目名：{data.get('title') or '未命名项目'}",
        f'- 项目 ID：{project_id}',
        f'- 项目目录：{project_dir}',
        '',
        '## 输入文件',
        f'- 口播稿：{script_path}',
        f"- 最终录音：{audio_path or '未提供（按 FredTalk 规则只能做到关键帧，不出整片）'}",
        f'- 字幕：{subtitles_path or "未提供"}',
        '',
        '## 素材',
    ]
    if materials:
        lines += ['| 文件 | 用途 | 必须 | 备注 |', '| --- | --- | --- | --- |']
        for item in materials:
            note = str(item.get('note') or '').replace('|', '\\|')
            lines.append(
                f"| {item['path']} | {item.get('role') or '素材'} | "
                f"{'是' if item.get('required') else '否'} | {note} |"
            )
    else:
        lines.append('- 未提供素材')
    lines += [
        '',
        '## 本轮范围',
        f"- {scope_labels.get(data.get('scope'), data.get('scope') or '逐段图文建议')}",
        '',
        '## 制作要求',
        f"- 必须保留：{requirements.get('mustKeep') or '未填写'}",
        f"- 禁止出现：{requirements.get('forbidden') or '未填写'}",
        f"- 品牌要求：{requirements.get('brand') or '未填写'}",
        f"- 隐私与遮挡：{requirements.get('privacy') or '未填写'}",
        f"- 补充说明：{data.get('notes') or '未填写'}",
        '',
        '## 给 Agent 的指令',
        '',
        '请使用 `fred-remotion-output` Skill 制作这条视频。先读取本交接单和口播稿，',
        '按 Skill 的默认顺序给出逐段图文建议；确认方向后再实现真实关键帧。',
        '素材缺失的段落请明确列出缺口，不要用不相关素材冒充真实证据。',
    ]
    return '\n'.join(lines) + '\n'

def media_file(record):
    if record.get('status') != 'reviewed':
        return None
    installed = [ROOT / relative for relative in record.get('installPaths', [])]
    for p in [*installed, ROOT / '.artifacts/objects' / record['sha256'], ROOT / 'library/demo' / record['sha256']]:
        if (p.resolve().is_relative_to(ROOT.resolve()) and not p.is_symlink() and p.is_file() and
                p.stat().st_size == record['size'] and
                (p not in installed or hashlib.sha256(p.read_bytes()).hexdigest() == record['sha256'])):
            return p
    return None

def public_preview_url(url):
    return isinstance(url, str) and bool(re.fullmatch(r'https://www\.fred-fu\.com/visual-library-app/objects/[a-f0-9]{64}\.(mp4|webm|jpg|jpeg|png|webp)', url))


def projection():
    data = read('catalog.json')
    routes = read('routes.json')
    media = read('media-manifest.json')['files']
    for item in data['items']:
        for source in item.get('sources', []):
            relative = source.get('installPath') or routes.get(source.get('url'))
            path = ROOT / relative if relative else None
            available = (path is not None and path.resolve().is_relative_to(ROOT.resolve()) and
                         path.is_file() and not path.is_symlink() and
                         (not source.get('sha256') or hashlib.sha256(path.read_bytes()).hexdigest() == source['sha256']))
            source['available'] = available
            source['status'] = 'ready' if available else ('member-download' if item.get('access') == 'members' else 'missing')
        download = item.get('projectDownload')
        if download:
            record = media.get(routes.get(download.get('url')), {})
            download['available'] = bool(record and media_file(record))
            download['status'] = 'ready' if download['available'] else ('member-download' if item.get('access') == 'members' else 'optional-download')
        for preview in item['previews']:
            target = routes.get(preview.get('videoUrl'))
            available = public_preview_url(preview.get('videoUrl')) or (target in media and media_file(media[target]) is not None)
            preview['available'] = available
            excluded = target in media and media[target]['status'] == 'quarantined'
            preview['status'] = 'ready' if available else ('privacy-excluded' if excluded else ('member-download' if item.get('access') == 'members' else 'optional-download'))
            if not available:
                preview['unavailableReason'] = ('这段预览因隐私检查被隔离，未随素材包分发。' if excluded else ('先在网站获取 Agent token，再运行 python3 scripts/assets.py download --members --collection ' + item['collectionId'] if item.get('access') == 'members' else '运行 python3 scripts/assets.py download 下载公开素材包。'))
    return data

class Handler(SimpleHTTPRequestHandler):
    def log_message(self, *_):
        pass

    def send_json(self, value, status=200):
        body = json.dumps(value, ensure_ascii=False).encode()
        self.send_response(status)
        self.send_header('Content-Type', 'application/json; charset=utf-8')
        self.send_header('Content-Length', str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def read_json_body(self, limit=2 * 1024 * 1024):
        length = int(self.headers.get('Content-Length') or 0)
        if length <= 0:
            return {}
        if length > limit:
            raise ValueError('请求体过大')
        return json.loads(self.rfile.read(length).decode('utf-8'))

    def intake_origin_allowed(self):
        origin = self.headers.get('Origin')
        if origin and not re.fullmatch(r'https?://(127\.0\.0\.1|localhost)(:\d+)?', origin):
            self.send_json({'error': '不允许的请求来源'}, 403)
            return False
        return True

    def handle_intake_create(self):
        data = self.read_json_body()
        title = str(data.get('title') or '未命名项目').strip()[:80] or '未命名项目'
        INTAKE_ROOT.mkdir(parents=True, exist_ok=True)
        project_id = f"{time.strftime('%Y%m%d-%H%M%S')}-{intake_slug(title)}-{secrets.token_hex(2)}"
        project_dir = INTAKE_ROOT / project_id
        project_dir.mkdir(parents=True, exist_ok=False)
        return self.send_json({'projectId': project_id, 'projectDir': str(project_dir)})

    def handle_intake_upload(self):
        params = parse_qs(urlsplit(self.path).query)
        project_id = (params.get('project') or [''])[0]
        relative_path = intake_relative_path((params.get('path') or [''])[0])
        project_dir = intake_project_dir(project_id)
        path = intake_file_path(project_dir, relative_path)
        length = int(self.headers.get('Content-Length') or 0)
        if length <= 0:
            raise ValueError('文件为空')
        if length > MAX_INTAKE_UPLOAD_BYTES:
            return self.send_json({'error': '单个文件超过 4GB 限制'}, 413)
        path.parent.mkdir(parents=True, exist_ok=True)
        remaining = length
        with path.open('wb') as target:
            while remaining > 0:
                chunk = self.rfile.read(min(1024 * 1024, remaining))
                if not chunk:
                    raise ValueError('上传中断')
                target.write(chunk)
                remaining -= len(chunk)
        return self.send_json({'ok': True, 'relativePath': relative_path, 'size': length})

    def handle_intake_save(self):
        data = self.read_json_body()
        project_id = str(data.get('projectId') or '')
        project_dir = intake_project_dir(project_id)

        script = data.get('script') or {}
        if script.get('mode') == 'text':
            text = str(script.get('text') or '')
            if not text.strip():
                raise ValueError('缺少口播稿')
            script_path = intake_file_path(project_dir, 'script/script.md')
            script_path.parent.mkdir(parents=True, exist_ok=True)
            script_path.write_text(text, encoding='utf-8')
            script_rel = 'script/script.md'
        else:
            script_rel = intake_relative_path(script.get('relPath') or '')
            script_path = intake_file_path(project_dir, script_rel)
            if not script_path.is_file():
                raise ValueError('口播稿文件不存在')

        def optional_file(section, label):
            if not section or not section.get('relPath'):
                return None, None
            rel = intake_relative_path(section.get('relPath'))
            path = intake_file_path(project_dir, rel)
            if not path.is_file():
                raise ValueError(f'{label}文件不存在')
            return path, rel

        audio_path, audio_rel = optional_file(data.get('audio'), '录音')
        subtitles_path, subtitles_rel = optional_file(data.get('subtitles'), '字幕')

        materials = []
        for item in data.get('materials') or []:
            rel = intake_relative_path(item.get('relPath') or '')
            path = intake_file_path(project_dir, rel)
            if not path.is_file():
                raise ValueError(f'素材文件不存在: {rel}')
            materials.append({
                'path': str(path),
                'relativePath': rel,
                'role': str(item.get('role') or '素材'),
                'required': bool(item.get('required')),
                'note': str(item.get('note') or ''),
            })

        requirements = {
            key: str((data.get('requirements') or {}).get(key) or '')
            for key in ('mustKeep', 'forbidden', 'brand', 'privacy')
        }
        intake = {
            'schemaVersion': 1,
            'createdAt': datetime.now().astimezone().isoformat(timespec='seconds'),
            'project': {
                'id': project_id,
                'title': str(data.get('title') or '未命名项目'),
                'dir': str(project_dir),
            },
            'script': {
                'mode': script.get('mode') or 'file',
                'path': str(script_path),
                'relativePath': script_rel,
            },
            'audio': {
                'path': str(audio_path) if audio_path else None,
                'relativePath': audio_rel,
            },
            'subtitles': {
                'path': str(subtitles_path) if subtitles_path else None,
                'relativePath': subtitles_rel,
            },
            'materials': materials,
            'scope': data.get('scope') or 'suggestions',
            'requirements': requirements,
            'notes': str(data.get('notes') or ''),
        }
        (project_dir / 'intake.json').write_text(
            json.dumps(intake, ensure_ascii=False, indent=2) + '\n',
            encoding='utf-8',
        )
        handoff = build_handoff(
            project_id,
            project_dir,
            data,
            script_path,
            audio_path,
            subtitles_path,
            materials,
        )
        (project_dir / 'handoff.md').write_text(handoff, encoding='utf-8')
        return self.send_json({
            'ok': True,
            'projectId': project_id,
            'projectDir': str(project_dir),
            'handoff': handoff,
            'scriptPath': str(script_path),
            'audioPath': str(audio_path) if audio_path else None,
            'subtitlesPath': str(subtitles_path) if subtitles_path else None,
            'materials': materials,
        })

    def do_GET(self):
        route = urlsplit(self.path).path
        if route == '/api/design-system':
            return self.send_json(projection())
        if route in ('/api/review', '/api/remake-curation'):
            state = self.review_state(route)
            return self.send_json({'state': state, 'catalog': {'fingerprint': 'portable-v1'}} if route == '/api/review' else state)
        routes = read('routes.json')
        target = routes.get(route)
        mime = None
        if target:
            record = read('media-manifest.json')['files'].get(target)
            if record:
                path = media_file(record)
                mime = mimetypes.guess_type('file.' + record['kind'])[0]
            else:
                path = (ROOT / target).resolve()
                if not path.is_relative_to(ROOT) or not path.is_file(): path = None
                mime = mimetypes.guess_type(target)[0] if target.startswith('library/fonts/') else 'text/plain; charset=utf-8'
        elif route in ('/', '/design', '/design/'):
            path = ROOT / 'apps/library/dist/index.html'
        elif route.startswith('/design/assets/'):
            name = unquote(route.removeprefix('/design/assets/'))
            path = (ROOT / 'apps/library/dist/assets' / name).resolve()
            if not path.is_relative_to(ROOT / 'apps/library/dist/assets'): path = None
        else:
            path = None
        if path is None or not path.is_file():
            return self.send_json({'error': 'Not found or optional asset not installed'}, 404)
        size = path.stat().st_size
        start, end, code = 0, size - 1, 200
        header = self.headers.get('Range')
        if header:
            match = re.fullmatch(r'bytes=(\d+)-(\d*)', header)
            if not match: return self.send_json({'error': 'Invalid range'}, 416)
            start = int(match[1]); end = min(int(match[2]) if match[2] else end, end)
            if start > end: return self.send_json({'error': 'Invalid range'}, 416)
            code = 206
        self.send_response(code)
        self.send_header('Content-Type', mime or mimetypes.guess_type(path.name)[0] or 'application/octet-stream')
        self.send_header('Content-Length', str(end-start+1))
        self.send_header('Accept-Ranges', 'bytes')
        if code == 206: self.send_header('Content-Range', f'bytes {start}-{end}/{size}')
        self.end_headers()
        try:
            with path.open('rb') as f:
                f.seek(start); remaining=end-start+1
                while remaining:
                    chunk=f.read(min(1024*1024,remaining))
                    if not chunk: break
                    self.wfile.write(chunk); remaining-=len(chunk)
        except (BrokenPipeError, ConnectionResetError): pass

    def review_state(self, route):
        path = ROOT / '.local' / ('review.json' if route == '/api/review' else 'remake.json')
        return json.loads(path.read_text()) if path.exists() else {'revision': 0, 'fingerprint': 'portable-v1', 'decisions': {}}

    def do_POST(self):
        route = urlsplit(self.path).path
        if route.startswith('/api/intake/'):
            if not self.intake_origin_allowed():
                return
            try:
                if route == '/api/intake/create':
                    return self.handle_intake_create()
                if route == '/api/intake/upload':
                    return self.handle_intake_upload()
                if route == '/api/intake/save':
                    return self.handle_intake_save()
                return self.send_json({'error': 'Not found'}, 404)
            except ValueError as exc:
                return self.send_json({'error': str(exc)}, 400)
            except Exception as exc:
                return self.send_json({'error': f'保存失败: {exc}'}, 500)
        if route not in ('/api/review','/api/remake-curation'): return self.send_json({'error':'Not found'},404)
        if self.headers.get('Origin') and self.headers['Origin'] != 'http://' + self.headers.get('Host',''):
            return self.send_json({'error':'Cross-origin writes are disabled'},403)
        try:
            length=int(self.headers.get('Content-Length','0'))
            if not 0 < length <= 32768: raise ValueError('Invalid body size')
            value=json.loads(self.rfile.read(length))
            if value.get('id') not in {i['id'] for i in read('catalog.json')['items']}: raise ValueError('Unknown item')
            if value.get('decision') not in {'keep','remove','reset','optional'}: raise ValueError('Unknown decision')
            with LOCK:
                state=self.review_state(route)
                if value.get('expectedRevision')!=state['revision'] or value.get('fingerprint')!='portable-v1': return self.send_json({'error':'Revision changed'},409)
                if value['decision']=='reset': state['decisions'].pop(value['id'],None)
                else: state['decisions'][value['id']]={'decision':value['decision'],'notes':str(value.get('notes',''))[:10000]}
                state['revision']+=1
                path=ROOT/'.local'/('review.json' if route=='/api/review' else 'remake.json');path.parent.mkdir(exist_ok=True)
                temp=path.with_suffix('.tmp');temp.write_text(json.dumps(state,ensure_ascii=False));temp.replace(path)
            self.send_json(state)
        except (ValueError,TypeError,json.JSONDecodeError) as e: self.send_json({'error':str(e)},400)

if __name__ == '__main__':
    parser=argparse.ArgumentParser();parser.add_argument('--port',type=int,default=3061);args=parser.parse_args()
    print(f'FredTalk: http://127.0.0.1:{args.port}/design/',flush=True)
    ThreadingHTTPServer(('127.0.0.1',args.port),Handler).serve_forever()
