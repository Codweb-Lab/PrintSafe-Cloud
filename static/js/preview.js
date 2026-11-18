// ========================================================================
// 📄 PRINTSAFE CLOUD — LIVE DOCUMENT PREVIEW & VECTOR PRINT (preview.js)
// ========================================================================

// ========================================================================
// 🖥️ FULLSCREEN PANE TOGGLE
// ========================================================================
function toggleFullscreenPane() {
  const col = document.querySelector(".integrated-preview-column");
  if (col) col.classList.toggle("fullscreen-pane");
}

// ========================================================================
// 👁️ IN-MEMORY STREAMING PREVIEW (LOCAL, CLOUD DRIVES & HOSTING SFTP/FTP)
// ========================================================================
async function showIntegratedPreview(
  filename,
  type,
  cardElement,
  filePassword = "",
  cloudId = null,
  accountId = null,
  accountName = "Local Vault",
  provider = "local",
  storageId = null,
  remotePath = null
) {
  activeThumbnailRequests.forEach((controller) => controller.abort());
  activeThumbnailRequests = [];

  const colWrapper = document.querySelector(".integrated-preview-column");
  if (colWrapper) colWrapper.classList.add("active-pane");

  const titleDisplay = document.getElementById("preview-filename-display");
  const pagesArea = document.getElementById("preview-raster-pages-area");
  const printBtn = document.getElementById("print-action-btn");
  if (!pagesArea) return;

  document.querySelectorAll(".file-card, .file-list-row").forEach((c) => c.classList.remove("active"));
  if (cardElement) cardElement.classList.add("active");

  if (printBtn) {
    printBtn.style.display = activeRestrictions.allow_print !== false ? "inline-flex" : "none";
  }
  if (titleDisplay) {
    titleDisplay.innerHTML = `${filename.split("/").pop()} <small style="display:block;font-size:10px;color:var(--text-sub);font-weight:500;">Source: ${accountName}</small>`;
  }

  activeFile = {
    name: filename,
    type,
    base64: null,
    binary: null,
    cloudId,
    accountId,
    accountName,
    provider,
    storageId,
    remotePath
  };
  decryptedCanvasCache = [];
  pagesArea.innerHTML = `<div class="stream-loader"><div class="vault-spinner"></div><span>Streaming encrypted document...</span></div>`;

  try {
    const response = await fetch("/fetch-file-data", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        password: savedPassword,
        filename: filename,
        cloud_id: cloudId,
        account_id: accountId,
        storage_id: storageId,
        remote_path: remotePath,
        session_id: currentSessionId
      })
    });

    if (!response.ok) throw new Error("Could not stream file bytes.");
    const fileData = await response.json();

    activeFile.base64 = fileData.base64;
    activeFile.binary = Uint8Array.from(atob(fileData.base64), (c) => c.charCodeAt(0));

    if (type === "pdf") {
      const loadingTask = pdfjsLib.getDocument({
        data: activeFile.binary.buffer.slice(0),
        password: filePassword
      });
      loadingTask.promise
        .then(async (pdf) => {
          pagesArea.innerHTML = "";
          for (let pageNum = 1; pageNum <= pdf.numPages; pageNum++) {
            const page = await pdf.getPage(pageNum);
            const canvas = document.createElement("canvas");
            canvas.className = "raster-page-preview";
            const viewport = page.getViewport({ scale: 1.2 });
            canvas.height = viewport.height;
            canvas.width = viewport.width;

            await page.render({ canvasContext: canvas.getContext("2d"), viewport }).promise;
            pagesArea.appendChild(canvas);

            const printCanvas = document.createElement("canvas");
            const printViewport = page.getViewport({ scale: 2.5 });
            printCanvas.height = printViewport.height;
            printCanvas.width = printViewport.width;
            await page.render({ canvasContext: printCanvas.getContext("2d"), viewport: printViewport }).promise;
            decryptedCanvasCache.push(printCanvas);
          }
        })
        .catch((err) => {
          if (err.name === "PasswordException") {
            protectedFilesList[filename] = true;
            pagesArea.innerHTML = `
              <div class="file-lock-form" style="padding:24px;text-align:center;">
                <i class="ri-lock-password-line" style="font-size:32px;color:var(--accent);"></i>
                <p style="font-size:13px;margin:10px 0;">Password Protected PDF</p>
                <input type="password" id="file-inner-pass" placeholder="Enter PDF Password" style="width:100%;padding:10px;margin-bottom:10px;border-radius:var(--radius-btn);border:1px solid var(--border);background:var(--bg-app);color:var(--text-title);">
                <button class="primary-submit-btn" onclick="submitFilePassword('${filename}', '${cloudId || ""}', '${accountId || ""}', '${storageId || ""}', '${remotePath || ""}')">Decrypt</button>
              </div>`;
            pagesArea.querySelector(".file-lock-form").cardRef = cardElement;
          }
        });
    } else {
      pagesArea.innerHTML = "";
      const img = document.createElement("img");
      img.className = "raster-page-preview";
      img.src = `data:image/jpeg;base64,${fileData.base64}`;
      pagesArea.appendChild(img);
    }
  } catch (error) {
    pagesArea.innerHTML = `<div style='color:#ef4444; padding:30px; text-align:center; font-size:13px;'><i class="ri-error-warning-line" style="font-size:28px;display:block;margin-bottom:6px;"></i>${error.message}</div>`;
  }
}

// ========================================================================
// ❌ CLOSE PREVIEW & SUBMIT PROTECTED PDF PASSWORD
// ========================================================================
function closePreviewPane() {
  const colWrapper = document.querySelector(".integrated-preview-column");
  if (colWrapper) {
    colWrapper.classList.remove("active-pane");
    colWrapper.classList.remove("fullscreen-pane");
  }
  document.querySelectorAll(".file-card, .file-list-row").forEach((c) => c.classList.remove("active"));
  activeFile = { name: null, type: null, base64: null, binary: null };
  decryptedCanvasCache = [];
}

function submitFilePassword(filename, cloudId, accountId, storageId = "", remotePath = "") {
  const container = document.getElementById("preview-raster-pages-area");
  const cardElement = container.querySelector(".file-lock-form").cardRef;
  const enteredPass = document.getElementById("file-inner-pass").value;
  if (!enteredPass) return;
  showIntegratedPreview(
    filename,
    "pdf",
    cardElement,
    enteredPass,
    cloudId || null,
    accountId || null,
    activeFile.accountName || "Vault",
    activeFile.provider || "local",
    storageId || null,
    remotePath || null
  );
}

// ========================================================================
// 🖨️ ZERO-FOOTPRINT VECTOR PRINT ENGINE
// ========================================================================
function triggerCleanVectorPrint() {
  if (!activeFile.base64) return;
  const existingFrame = document.getElementById("hidden-print-iframe");
  if (existingFrame) document.body.removeChild(existingFrame);

  const iframe = document.createElement("iframe");
  iframe.id = "hidden-print-iframe";
  iframe.style.cssText = "position:fixed;width:0;height:0;border:none;visibility:hidden;";
  document.body.appendChild(iframe);

  const isPdf = activeFile.type === "pdf";
  function cleanupPrintStream() {
    if (document.body.contains(iframe)) document.body.removeChild(iframe);
  }
  iframe.contentWindow.onafterprint = cleanupPrintStream;

  if (isPdf && protectedFilesList[activeFile.name] && decryptedCanvasCache.length > 0) {
    const pdoc = iframe.contentWindow.document;
    pdoc.open();
    pdoc.write(`<!DOCTYPE html><html><head><style>body{margin:0;text-align:center;}canvas{width:100%!important;height:auto!important;display:block;page-break-after:always;}@page{margin:0;size:auto;}</style></head><body></body></html>`);
    pdoc.close();
    decryptedCanvasCache.forEach((canvasElement) => {
      const newCanvas = pdoc.createElement("canvas");
      newCanvas.width = canvasElement.width;
      newCanvas.height = canvasElement.height;
      newCanvas.getContext("2d").drawImage(canvasElement, 0, 0);
      pdoc.body.appendChild(newCanvas);
    });
    iframe.contentWindow.focus();
    iframe.contentWindow.print();
    cleanupPrintStream();
  } else {
    const blob = new Blob([activeFile.binary.buffer.slice(0)], { type: isPdf ? "application/pdf" : "image/jpeg" });
    const blobURL = URL.createObjectURL(blob);
    iframe.onload = () => {
      iframe.contentWindow.focus();
      iframe.contentWindow.print();
    };
    iframe.src = blobURL;
  }
}