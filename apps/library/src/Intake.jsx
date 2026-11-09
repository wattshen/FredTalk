import React, { useRef, useState } from "react";
import { Heading, download } from "./UI.jsx";
import "./intake.css";

const MATERIAL_CATEGORIES = [
  {
    id: "recording",
    title: "录屏 / 操作视频",
    formats: "MP4、MOV、MKV、WebM、AVI",
    accept: ".mp4,.mov,.mkv,.webm,.avi",
    role: "录屏/视频",
    folder: "recordings",
  },
  {
    id: "screenshots",
    title: "截图 / 图片",
    formats: "PNG、JPG、JPEG、WebP、GIF、BMP、SVG",
    accept: ".png,.jpg,.jpeg,.webp,.gif,.bmp,.svg",
    role: "截图/原文",
    folder: "screenshots",
  },
  {
    id: "broll",
    title: "实拍 / B-roll",
    formats: "MP4、MOV、MKV、WebM、AVI",
    accept: ".mp4,.mov,.mkv,.webm,.avi",
    role: "实拍/B-roll",
    folder: "broll",
  },
  {
    id: "brand",
    title: "品牌资产",
    formats: "PNG、JPG、JPEG、WebP、SVG",
    accept: ".png,.jpg,.jpeg,.webp,.svg",
    role: "品牌资产",
    folder: "brand",
  },
  {
    id: "reference",
    title: "参考素材 / 文档",
    formats: "MD、TXT、DOC、DOCX、PDF、图片、视频",
    accept: ".md,.txt,.doc,.docx,.pdf,.png,.jpg,.jpeg,.webp,.svg,.mp4,.mov,.webm",
    role: "参考素材",
    folder: "references",
  },
  {
    id: "other",
    title: "其他素材",
    formats: "任意文件",
    accept: "",
    role: "其他",
    folder: "other",
  },
];

const SCOPES = [
  ["suggestions", "逐段建议"],
  ["keyframes", "建议 + 关键帧"],
  ["full", "完整视频"],
];

function isAllowedFile(name, category) {
  if (!category.accept) return true;
  const dot = name.lastIndexOf(".");
  if (dot < 0) return false;
  return category.accept.split(",").includes(name.slice(dot).toLowerCase());
}

function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 ** 3) return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
  return `${(bytes / 1024 ** 3).toFixed(2)} GB`;
}

function uniquePath(relativePath, usedPaths) {
  if (!usedPaths.has(relativePath)) return relativePath;
  const slash = relativePath.lastIndexOf("/");
  const dir = slash >= 0 ? relativePath.slice(0, slash + 1) : "";
  const name = slash >= 0 ? relativePath.slice(slash + 1) : relativePath;
  const dot = name.lastIndexOf(".");
  const stem = dot > 0 ? name.slice(0, dot) : name;
  const ext = dot > 0 ? name.slice(dot) : "";
  let index = 2;
  let candidate = `${dir}${stem}-${index}${ext}`;
  while (usedPaths.has(candidate)) {
    index += 1;
    candidate = `${dir}${stem}-${index}${ext}`;
  }
  return candidate;
}

function readAllEntries(reader) {
  return new Promise((resolve, reject) => {
    const entries = [];
    const read = () => {
      reader.readEntries((batch) => {
        if (!batch.length) {
          resolve(entries);
          return;
        }
        entries.push(...batch);
        read();
      }, reject);
    };
    read();
  });
}

async function collectEntry(entry, basePath, output) {
  if (entry.isFile) {
    const file = await new Promise((resolve, reject) => entry.file(resolve, reject));
    output.push({
      file,
      relativePath: basePath ? `${basePath}/${file.name}` : file.name,
    });
    return;
  }
  if (entry.isDirectory) {
    const children = await readAllEntries(entry.createReader());
    const nextBase = basePath ? `${basePath}/${entry.name}` : entry.name;
    for (const child of children) await collectEntry(child, nextBase, output);
  }
}

function postJson(url, body) {
  return fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  }).then(async (response) => {
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || `请求失败 (${response.status})`);
    return data;
  });
}

function uploadFile(projectId, relativePath, file, onProgress) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open(
      "POST",
      `/api/intake/upload?project=${encodeURIComponent(projectId)}&path=${encodeURIComponent(relativePath)}`,
    );
    xhr.upload.onprogress = (event) => {
      if (event.lengthComputable) onProgress(event.loaded / event.total);
    };
    xhr.onload = () => {
      let data = {};
      try {
        data = JSON.parse(xhr.responseText || "{}");
      } catch {
        data = {};
      }
      if (xhr.status >= 200 && xhr.status < 300) resolve(data);
      else reject(new Error(data.error || `上传失败 (${xhr.status})`));
    };
    xhr.onerror = () => reject(new Error("网络错误，上传失败"));
    xhr.send(file);
  });
}

function FileRow({ file, onClear }) {
  if (!file) return null;
  return (
    <div className="intake-file-row">
      <span>{file.name}</span>
      <small>{formatBytes(file.size)}</small>
      <button type="button" className="intake-link" onClick={onClear}>移除</button>
    </div>
  );
}

export function Intake() {
  const [title, setTitle] = useState("");
  const [scriptMode, setScriptMode] = useState("text");
  const [scriptText, setScriptText] = useState("");
  const [scriptFile, setScriptFile] = useState(null);
  const [audioFile, setAudioFile] = useState(null);
  const [subtitleFile, setSubtitleFile] = useState(null);
  const [materials, setMaterials] = useState([]);
  const [scope, setScope] = useState("suggestions");
  const [requirements, setRequirements] = useState({
    mustKeep: "",
    forbidden: "",
    brand: "",
    privacy: "",
  });
  const [notes, setNotes] = useState("");
  const [dragCategory, setDragCategory] = useState("");
  const [saving, setSaving] = useState(false);
  const [progress, setProgress] = useState("");
  const [error, setError] = useState("");
  const [result, setResult] = useState(null);
  const projectRef = useRef(null);

  const addMaterialFiles = (incoming, category) => {
    const accepted = [];
    const rejected = [];
    for (const item of incoming) {
      if (!item.file) continue;
      if (isAllowedFile(item.file.name, category)) accepted.push(item);
      else rejected.push(item.file.name);
    }
    if (rejected.length) {
      setError(`以下文件不属于“${category.title}”：${rejected.slice(0, 3).join("、")}${rejected.length > 3 ? " 等" : ""}`);
    } else {
      setError("");
    }
    setMaterials((current) => {
      const used = new Set(
        current.filter((item) => item.categoryId === category.id).map((item) => item.relativePath),
      );
      const next = [...current];
      for (const item of accepted) {
        const raw = (item.relativePath || item.file.name).replace(/\\/g, "/").replace(/^\/+/, "");
        const relativePath = uniquePath(raw, used);
        used.add(relativePath);
        next.push({
          id: `${Date.now()}-${Math.random().toString(16).slice(2)}`,
          file: item.file,
          relativePath,
          categoryId: category.id,
          categoryTitle: category.title,
          folder: category.folder,
          role: category.role,
          required: true,
          note: "",
        });
      }
      return next;
    });
  };

  const handleDrop = async (event, category) => {
    event.preventDefault();
    setDragCategory("");
    const items = Array.from(event.dataTransfer.items || []);
    if (items.length && items[0].webkitGetAsEntry) {
      const collected = [];
      for (const item of items) {
        const entry = item.webkitGetAsEntry();
        if (entry) await collectEntry(entry, "", collected);
      }
      addMaterialFiles(collected, category);
      return;
    }
    addMaterialFiles(
      Array.from(event.dataTransfer.files || []).map((file) => ({
        file,
        relativePath: file.webkitRelativePath || file.name,
      })),
      category,
    );
  };

  const updateRequirement = (key, value) => {
    setRequirements((current) => ({ ...current, [key]: value }));
  };

  const removeMaterial = (id) => {
    setMaterials((current) => current.filter((item) => item.id !== id));
  };

  const saveProject = async () => {
    setError("");
    setResult(null);
    if (scriptMode === "text" && !scriptText.trim()) {
      setError("请粘贴口播稿，或切换到“上传文件”。");
      return;
    }
    if (scriptMode === "file" && !scriptFile) {
      setError("请选择口播稿文件。");
      return;
    }

    setSaving(true);
    try {
      if (!projectRef.current) {
        setProgress("创建项目目录…");
        projectRef.current = await postJson("/api/intake/create", {
          title: title.trim() || "未命名项目",
        });
      }
      const projectId = projectRef.current.projectId;
      const uploads = [];
      if (scriptMode === "file" && scriptFile) {
        uploads.push({ relativePath: `script/${scriptFile.name}`, file: scriptFile });
      }
      if (audioFile) uploads.push({ relativePath: `audio/${audioFile.name}`, file: audioFile });
      if (subtitleFile) {
        uploads.push({ relativePath: `subtitles/${subtitleFile.name}`, file: subtitleFile });
      }
      for (const material of materials) {
        uploads.push({
          relativePath: `materials/${material.folder}/${material.relativePath}`,
          file: material.file,
        });
      }

      for (let index = 0; index < uploads.length; index += 1) {
        const item = uploads[index];
        setProgress(`上传 ${index + 1}/${uploads.length}：${item.relativePath}`);
        await uploadFile(projectId, item.relativePath, item.file, (ratio) => {
          setProgress(
            `上传 ${index + 1}/${uploads.length}：${item.relativePath} · ${Math.round(ratio * 100)}%`,
          );
        });
      }

      setProgress("写入交接单…");
      const payload = {
        projectId,
        title: title.trim() || "未命名项目",
        script:
          scriptMode === "text"
            ? { mode: "text", text: scriptText }
            : { mode: "file", relPath: `script/${scriptFile.name}` },
        audio: audioFile ? { relPath: `audio/${audioFile.name}` } : null,
        subtitles: subtitleFile ? { relPath: `subtitles/${subtitleFile.name}` } : null,
        materials: materials.map((material) => ({
          relPath: `materials/${material.folder}/${material.relativePath}`,
          role: material.role,
          required: material.required,
          note: material.note,
        })),
        scope,
        requirements,
        notes,
      };
      const saved = await postJson("/api/intake/save", payload);
      projectRef.current = null;
      setResult(saved);
      setProgress("");
    } catch (saveError) {
      const suffix = projectRef.current ? `（项目目录：${projectRef.current.projectDir}）` : "";
      setError(`${saveError.message || saveError}${suffix}`);
      setProgress("");
    } finally {
      setSaving(false);
    }
  };

  const copyHandoff = async () => {
    if (!result?.handoff) return;
    try {
      await navigator.clipboard.writeText(result.handoff);
      setProgress("交接单已复制。");
    } catch {
      setProgress("复制失败，请打开 handoff.md 手动复制。");
    }
  };

  return (
    <div className="intake-page">
      <Heading page="intake" />
      <div className="intake-layout">
        <div className="intake-form">
          <section className="intake-card">
            <h2>项目</h2>
            <label className="intake-label" htmlFor="intake-title">项目名</label>
            <input
              id="intake-title"
              className="intake-input"
              value={title}
              onChange={(event) => setTitle(event.target.value)}
              placeholder="例如：126 期 / 产品演示"
            />
            <p className="intake-hint">
              保存位置：<code>D:\output\fredtalk-intake\&lt;自动生成的项目 ID&gt;\</code>
            </p>
          </section>

          <section className="intake-card">
            <div className="intake-section-head">
              <h2>口播稿</h2>
              <div className="intake-tabs" role="group" aria-label="口播稿输入方式">
                <button
                  type="button"
                  aria-pressed={scriptMode === "text"}
                  onClick={() => setScriptMode("text")}
                >
                  粘贴文本
                </button>
                <button
                  type="button"
                  aria-pressed={scriptMode === "file"}
                  onClick={() => setScriptMode("file")}
                >
                  上传文件
                </button>
              </div>
            </div>
            <p className="intake-hint">
              文件支持 MD、TXT、DOC、DOCX、PDF；粘贴文本会保存为 script/script.md。
            </p>
            {scriptMode === "text" ? (
              <>
                <textarea
                  className="intake-textarea"
                  value={scriptText}
                  onChange={(event) => setScriptText(event.target.value)}
                  placeholder="把最终口播稿粘贴到这里。保存时会写入 script/script.md。"
                  rows={10}
                />
                <p className="intake-hint">{scriptText.length} 字</p>
              </>
            ) : (
              <>
                <input
                  type="file"
                  accept=".md,.txt,.doc,.docx,.pdf"
                  onChange={(event) => {
                    setScriptFile(event.target.files?.[0] || null);
                    event.target.value = "";
                  }}
                />
                <FileRow file={scriptFile} onClear={() => setScriptFile(null)} />
              </>
            )}
          </section>

          <section className="intake-card">
            <h2>音频与字幕</h2>
            <div className="intake-two-col">
              <div>
                <label className="intake-label">最终录音</label>
                <p className="intake-hint">支持 MP3、WAV、M4A、AAC、FLAC、OGG</p>
                <input
                  type="file"
                  accept=".mp3,.wav,.m4a,.aac,.flac,.ogg"
                  onChange={(event) => {
                    setAudioFile(event.target.files?.[0] || null);
                    event.target.value = "";
                  }}
                />
                <FileRow file={audioFile} onClear={() => setAudioFile(null)} />
              </div>
              <div>
                <label className="intake-label">字幕文件</label>
                <p className="intake-hint">支持 SRT、ASS、VTT</p>
                <input
                  type="file"
                  accept=".srt,.ass,.vtt"
                  onChange={(event) => {
                    setSubtitleFile(event.target.files?.[0] || null);
                    event.target.value = "";
                  }}
                />
                <FileRow file={subtitleFile} onClear={() => setSubtitleFile(null)} />
              </div>
            </div>
            <p className="intake-hint">
              完整视频需要最终录音；没有录音时仍可保存项目，但交接单会标注只能做到关键帧。
            </p>
          </section>

          <section className="intake-card">
            <div className="intake-section-head">
              <h2>素材</h2>
              <small>{materials.length} 个文件</small>
            </div>
            <p className="intake-hint">
              按类型分开上传；每类格式见标题下方。目录上传会保留目录内的相对路径。
            </p>
            <div className="intake-material-categories">
              {MATERIAL_CATEGORIES.map((category) => {
                const categoryMaterials = materials.filter(
                  (item) => item.categoryId === category.id,
                );
                return (
                  <div className="intake-material-category" key={category.id}>
                    <div className="intake-category-head">
                      <div>
                        <h3>{category.title}</h3>
                        <small>{category.formats}</small>
                      </div>
                      <span>{categoryMaterials.length} 个</span>
                    </div>
                    <div
                      className={
                        "intake-material-drop " +
                        (dragCategory === category.id ? "active" : "")
                      }
                      onDragOver={(event) => {
                        event.preventDefault();
                        setDragCategory(category.id);
                      }}
                      onDragLeave={() => setDragCategory("")}
                      onDrop={(event) => handleDrop(event, category)}
                    >
                      <span>拖拽{category.title}到这里</span>
                      <div className="intake-drop-actions">
                        <label className="intake-button">
                          选择文件
                          <input
                            type="file"
                            multiple
                            accept={category.accept || undefined}
                            hidden
                            onChange={(event) => {
                              addMaterialFiles(
                                Array.from(event.target.files || []).map((file) => ({
                                  file,
                                  relativePath: file.webkitRelativePath || file.name,
                                })),
                                category,
                              );
                              event.target.value = "";
                            }}
                          />
                        </label>
                        <label className="intake-button">
                          选择目录
                          <input
                            type="file"
                            multiple
                            webkitdirectory=""
                            accept={category.accept || undefined}
                            hidden
                            onChange={(event) => {
                              addMaterialFiles(
                                Array.from(event.target.files || []).map((file) => ({
                                  file,
                                  relativePath: file.webkitRelativePath || file.name,
                                })),
                                category,
                              );
                              event.target.value = "";
                            }}
                          />
                        </label>
                      </div>
                    </div>
                    {categoryMaterials.length > 0 && (
                      <div className="intake-materials">
                        {categoryMaterials.map((material) => (
                          <div className="intake-material" key={material.id}>
                            <div className="intake-material-name">
                              <strong>{material.relativePath}</strong>
                              <small>
                                {formatBytes(material.file.size)} · {material.role}
                              </small>
                            </div>
                            <label className="intake-check">
                              <input
                                type="checkbox"
                                checked={material.required}
                                onChange={(event) => {
                                  const required = event.target.checked;
                                  setMaterials((current) =>
                                    current.map((item) =>
                                      item.id === material.id ? { ...item, required } : item,
                                    ),
                                  );
                                }}
                              />
                              必须
                            </label>
                            <input
                              className="intake-material-note"
                              value={material.note}
                              onChange={(event) => {
                                const note = event.target.value;
                                setMaterials((current) =>
                                  current.map((item) =>
                                    item.id === material.id ? { ...item, note } : item,
                                  ),
                                );
                              }}
                              placeholder="备注 / 可用入出点"
                            />
                            <button
                              type="button"
                              className="intake-link"
                              onClick={() => removeMaterial(material.id)}
                            >
                              移除
                            </button>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          </section>

          <section className="intake-card">
            <h2>制作范围与要求</h2>
            <label className="intake-label" htmlFor="intake-scope">本轮范围</label>
            <select
              id="intake-scope"
              className="intake-input"
              value={scope}
              onChange={(event) => setScope(event.target.value)}
            >
              {SCOPES.map(([value, label]) => <option key={value} value={value}>{label}</option>)}
            </select>
            <div className="intake-two-col">
              <div>
                <label className="intake-label">必须保留</label>
                <textarea
                  className="intake-textarea short"
                  value={requirements.mustKeep}
                  onChange={(event) => updateRequirement("mustKeep", event.target.value)}
                  placeholder="原话、品牌、固定画面、不能改的内容"
                />
              </div>
              <div>
                <label className="intake-label">禁止出现</label>
                <textarea
                  className="intake-textarea short"
                  value={requirements.forbidden}
                  onChange={(event) => updateRequirement("forbidden", event.target.value)}
                  placeholder="不要出现的词、颜色、构图或素材"
                />
              </div>
              <div>
                <label className="intake-label">品牌要求</label>
                <textarea
                  className="intake-textarea short"
                  value={requirements.brand}
                  onChange={(event) => updateRequirement("brand", event.target.value)}
                  placeholder="Logo、角标、字体、颜色"
                />
              </div>
              <div>
                <label className="intake-label">隐私与遮挡</label>
                <textarea
                  className="intake-textarea short"
                  value={requirements.privacy}
                  onChange={(event) => updateRequirement("privacy", event.target.value)}
                  placeholder="账号、密钥、群聊、客户信息"
                />
              </div>
            </div>
            <label className="intake-label" htmlFor="intake-notes">补充说明</label>
            <textarea
              id="intake-notes"
              className="intake-textarea short"
              value={notes}
              onChange={(event) => setNotes(event.target.value)}
              placeholder="其他制作要求"
            />
          </section>

          <div className="intake-submit">
            <button type="button" className="intake-primary" onClick={saveProject} disabled={saving}>
              {saving ? "正在保存…" : "保存项目到磁盘"}
            </button>
            {progress && <span className="intake-progress">{progress}</span>}
            {error && <p className="intake-error" role="alert">{error}</p>}
          </div>
        </div>

        <aside className="intake-side">
          <section className="intake-card intake-preview">
            <h2>生成的交接单</h2>
            {result ? (
              <>
                <p className="intake-saved">已保存到：<code>{result.projectDir}</code></p>
                <div className="intake-preview-actions">
                  <button type="button" className="intake-button" onClick={copyHandoff}>复制交接单</button>
                  <button
                    type="button"
                    className="intake-button"
                    onClick={() => download("handoff.md", result.handoff, "text/markdown;charset=utf-8")}
                  >
                    下载 handoff.md
                  </button>
                </div>
                <pre className="intake-handoff">{result.handoff}</pre>
              </>
            ) : (
              <p className="intake-empty">
                填写左侧内容后点击“保存项目到磁盘”。保存后会在这里显示交接单，可复制或下载。
              </p>
            )}
          </section>
        </aside>
      </div>
    </div>
  );
}
