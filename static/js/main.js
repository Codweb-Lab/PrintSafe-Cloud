// Global thumbnail cache manager
const thumbnailCache = {};

pdfjsLib.GlobalWorkerOptions.workerSrc = '/static/js/pdf.worker.min.js';
  //"{{ url_for('static', filename='./pdf.worker.min.js') }}";

document.addEventListener("keydown", (e) => {
  if (e.ctrlKey && (e.key === "s" || e.key === "S")) e.preventDefault();
});

// Global Variables
let activeFile = { name: null, type: null, base64: null, binary: null };
let savedPassword = "";
let activeThumbnailRequests = [];
let protectedFilesList = {};
let decryptedCanvasCache = [];

// Global States for Drive Navigation
let globalVaultTree = []; // The complete nested tree from the backend will reside here
let currentFolderNavigation = []; // The folder the user is currently in (e.g., ['Folder1', 'SubFolder2'])

function toggleFullscreenPane() {
  const pane = document.getElementById("integrated-preview-pane");
  pane.classList.toggle("fullscreen-pane");
}

function formatFileSize(bytes) {
  if (!bytes) return "0 KB";
  const kb = bytes / 1024;
  if (kb < 1024) return kb.toFixed(1) + " KB";
  const mb = kb / 1024;
  return mb.toFixed(1) + " MB";
}

// Live Stream Side Preview (Now supports the full file path)
async function showIntegratedPreview(
  filename,
  type,
  cardElement,
  filePassword = "",
) {
  activeThumbnailRequests.forEach((controller) => controller.abort());
  activeThumbnailRequests = [];

  const previewPane = document.getElementById("integrated-preview-pane");
  const titleDisplay = document.getElementById("preview-filename-display");
  const pagesArea = document.getElementById("preview-raster-pages-area");
  const printBtn = document.getElementById("print-action-btn");
  const printerSelect = document.getElementById("printer-select-area");

  document
    .querySelectorAll(".file-card")
    .forEach((c) => c.classList.remove("active"));
  cardElement.classList.add("active");

  previewPane.style.display = "flex";
  printBtn.style.display = "block";
  printerSelect.style.display = "block";

  // Show only the last name for display, but keep the full path for backend requests
  titleDisplay.innerText = filename.split("/").pop();

  decryptedCanvasCache = [];

  pagesArea.innerHTML = `
                <div class="stream-loader">
                    <span style="color:#1a73e8; font-weight:600; font-size:13px;">⚡ Streaming secure bytes from server...</span>
                    <div class="progress-line"></div>
                </div>
            `;

  try {
    const response = await fetch("/fetch-file-data", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ password: savedPassword, filename: filename }), // Send the full path
    });

    if (!response.ok) throw new Error("Stream connection failed.");
    const fileData = await response.json();

    activeFile.name = filename;
    activeFile.type = type;
    activeFile.base64 = fileData.base64;
    activeFile.binary = Uint8Array.from(atob(fileData.base64), (c) =>
      c.charCodeAt(0),
    );

    if (type === "pdf") {
      const loadingTask = pdfjsLib.getDocument({
        data: activeFile.binary.buffer.slice(0),
        password: filePassword,
      });

      loadingTask.promise
        .then(async (pdf) => {
          pagesArea.innerHTML = "";

          for (let pageNum = 1; pageNum <= pdf.numPages; pageNum++) {
            const page = await pdf.getPage(pageNum);

            const canvas = document.createElement("canvas");
            canvas.className = "raster-page-preview";
            const viewport = page.getViewport({ scale: 1.3 });
            canvas.height = viewport.height;
            canvas.width = viewport.width;
            await page.render({
              canvasContext: canvas.getContext("2d"),
              viewport: viewport,
            }).promise;
            pagesArea.appendChild(canvas);

            const printCanvas = document.createElement("canvas");
            const printContext = printCanvas.getContext("2d");
            const printViewport = page.getViewport({ scale: 3.0 });
            printCanvas.height = printViewport.height;
            printCanvas.width = printViewport.width;

            await page.render({
              canvasContext: printContext,
              viewport: printViewport,
            }).promise;
            decryptedCanvasCache.push(printCanvas);
          }
        })
        .catch((err) => {
          if (err.name === "PasswordException") {
            protectedFilesList[filename] = true;

            pagesArea.innerHTML = `
                                <div class="file-lock-form">
                                    <div style="font-size:30px; margin-bottom:10px;">🔒</div>
                                    <span style="font-size:13px; font-weight:600; color:#3c4043;">This file is password protected</span>
                                    <input type="password" id="file-inner-pass" placeholder="Enter File Password" onkeydown="if(event.key==='Enter') submitFilePassword('${filename}', cardElement)">
                                    <button class="btn" style="padding:8px; font-size:12px;" onclick="submitFilePassword('${filename}', this.parentElement)">Decrypt & View</button>
                                </div>
                            `;
            pagesArea.querySelector(".file-lock-form").cardRef = cardElement;
          } else {
            pagesArea.innerHTML = `<p style='color:red;'>Render Error: ${err.message}</p>`;
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
    pagesArea.innerHTML = `<p style='color:red; padding:20px;'>Render Error: ${error.message}</p>`;
  }
}


function submitFilePassword(filename, formElement) {
  const container = document.getElementById("preview-raster-pages-area");
  const cardElement = container.querySelector(".file-lock-form").cardRef;
  const enteredPass = document.getElementById("file-inner-pass").value;
  if (!enteredPass) return;
  showIntegratedPreview(filename, "pdf", cardElement, enteredPass);
}

/* 🎯 🖨️ The Ultimate Timer-Free Event Printer Engine */
function triggerCleanVectorPrint() {
  if (!activeFile.base64) return;

  const existingFrame = document.getElementById("hidden-print-iframe");
  if (existingFrame) document.body.removeChild(existingFrame);

  const iframe = document.createElement("iframe");
  iframe.id = "hidden-print-iframe";
  iframe.style.position = "fixed";
  iframe.style.width = "0px";
  iframe.style.height = "0px";
  iframe.style.border = "none";
  iframe.style.visibility = "hidden";
  document.body.appendChild(iframe);

  const isPdf = activeFile.type === "pdf";

  function cleanupPrintStream() {
    console.log("🔒 Print session closed. Purging temporary iframe...");
    if (document.body.contains(iframe)) document.body.removeChild(iframe);
  }

  iframe.contentWindow.onafterprint = cleanupPrintStream;

  if (
    isPdf &&
    protectedFilesList[activeFile.name] &&
    decryptedCanvasCache.length > 0
  ) {
    console.log(
      "🛡️ Protected PDF: Injecting high-res canvases directly into DOM...",
    );
    const pri = iframe.contentWindow || iframe.contentDocument;
    const pdoc = pri.document || pri;

    pdoc.open();
    pdoc.write(`
                    <!DOCTYPE html>
                    <html>
                    <head>
                        <title>Print Stream</title>
                        <style>
                            body { margin: 0; padding: 0; background: white; text-align: center; }
                            canvas { width: 100% !important; max-width: 100% !important; height: auto !important; display: block; page-break-after: always; }
                            canvas:last-child { page-break-after: avoid; }
                            @page { margin: 0; size: auto; }
                        </style>
                    </head>
                    <body></body>
                    </html>
                `);
    pdoc.close();

    decryptedCanvasCache.forEach((canvasElement) => {
      const newCanvas = pdoc.createElement("canvas");
      newCanvas.width = canvasElement.width;
      newCanvas.height = canvasElement.height;
      const ctx = newCanvas.getContext("2d");
      ctx.drawImage(canvasElement, 0, 0);
      pdoc.body.appendChild(newCanvas);
    });

    iframe.contentWindow.focus();
    iframe.contentWindow.print();
    cleanupPrintStream();
  } else {
    console.log("⚡ Normal File: Setting up network blob pipeline...");
    const mimeType = isPdf ? "application/pdf" : "image/jpeg";
    const blob = new Blob([activeFile.binary.buffer.slice(0)], {
      type: mimeType,
    });
    const blobURL = URL.createObjectURL(blob);

    iframe.onload = function () {
      iframe.contentWindow.focus();
      iframe.contentWindow.print();
    };

    const originalAfterPrint = iframe.contentWindow.onafterprint;
    iframe.contentWindow.onafterprint = function () {
      URL.revokeObjectURL(blobURL);
      if (originalAfterPrint) originalAfterPrint();
      cleanupPrintStream();
    };

    iframe.src = blobURL;
  }
}

function closePreviewPane() {
  document.getElementById("integrated-preview-pane").style.display = "none";
  document
    .getElementById("integrated-preview-pane")
    .classList.remove("fullscreen-pane"); // Reset fullscreen
  document
    .querySelectorAll(".file-card")
    .forEach((c) => c.classList.remove("active"));
  activeFile = { name: null, type: null, base64: null, binary: null };
  decryptedCanvasCache = [];
}

// Customized the login response for a nested structure.
async function unlockVault() {
  const password = document.getElementById("secret-key").value;
  savedPassword = password;

  try {
    const response = await fetch("/fetch-vault-list", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ password: password }),
    });

    if (!response.ok) {
      alert("Access Denied!");
      return;
    }
    const data = await response.json();

    document.getElementById("auth-container").style.display = "none";
    document.getElementById("file-manager-dashboard").style.display = "flex";

    // Keep the tree structure in a global variable and reset navigation
    globalVaultTree = data.tree;
    currentFolderNavigation = [];
    renderCurrentFolderLevel();
  } catch (error) {
    alert("Error: " + error.message);
  }
}

// New State Variables for Lazy Loading
let lazyFilteredItems = []; // The list of files remaining after filtering and sorting
let lazyCurrentIndex = 0; // How many items have been rendered so far
const LAZY_PAGE_SIZE = 24; // How many items to show on the screen at once
let lazyObserver = null; // The observer to detect scrolling

// The Ultimate Lazy-Load Explorer Engine
function renderCurrentFolderLevel(appendMode = false) {
  const grid =
    document.getElementById("main-explorer-grid") ||
    document.getElementById("category-view-pane");
  const pathDisplay = document.getElementById("current-folder-path-display");
  const backBtn = document.getElementById("back-folder-btn");
  const loadTrigger = document.getElementById("lazy-load-trigger");

  // If we are opening the folder for the first time (appendMode === false), clear old requests
  if (!appendMode) {
    if (activeThumbnailRequests && activeThumbnailRequests.length > 0) {
      activeThumbnailRequests.forEach((controller) => {
        try {
          controller.abort();
        } catch (e) {}
      });
      activeThumbnailRequests = [];
    }
    grid.innerHTML = "";
    lazyCurrentIndex = 0;

    // Close the Old Scroll Observer.
    if (lazyObserver) {
      lazyObserver.disconnect();
      lazyObserver = null;
    }
  }

  // Read Inputs
  const searchQuery = (
    document.getElementById("drive-search-input")?.value || ""
  )
    .toLowerCase()
    .trim();
  const typeFilter =
    document.getElementById("drive-type-filter")?.value || "all";
  const sortBy = document.getElementById("drive-sort-by")?.value || "name-asc";

  // 1. If we are doing a fresh load, collect, filter, and sort the entire dataset
  if (!appendMode) {
    let currentItems = globalVaultTree;
    let pathStrings = ["Root Drive"];

    currentFolderNavigation.forEach((folderName) => {
      pathStrings.push(folderName);
      const targetFolder = currentItems.find(
        (item) => item.type === "folder" && item.name === folderName,
      );
      if (targetFolder && targetFolder.children) {
        currentItems = targetFolder.children;
      }
    });

    if (backBtn)
      backBtn.style.display =
        currentFolderNavigation.length > 0 ? "block" : "none";
    if (pathDisplay) pathDisplay.innerText = pathStrings.join(" ➔ ");

    // 🔍 In-Memory Filtering
    lazyFilteredItems = currentItems.filter((item) => {
      const matchesSearch = item.name.toLowerCase().includes(searchQuery);
      let matchesType = true;
      if (item.type === "file") {
        if (typeFilter === "pdf" && item.file_type !== "pdf")
          matchesType = false;
        if (typeFilter === "image" && item.file_type !== "image")
          matchesType = false;
      } else if (item.type === "folder") {
        if (typeFilter !== "all" && !searchQuery) matchesType = false;
      }
      return matchesSearch && matchesType;
    });

    // जैसे ही फोल्डर का डेटा फ़िल्टर होकर तैयार हो, उसे तुरंत ए-जेड के लिए सिंक करें
  if (!appendMode) {
      window.currentDirectoryItemsRaw = lazyFilteredItems;
  }

    // In-Memory Sorting
    lazyFilteredItems.sort((a, b) => {
      if (a.type === "folder" && b.type !== "folder") return -1;
      if (a.type !== "folder" && b.type === "folder") return 1;

      if (sortBy === "name-asc")
        return a.name.localeCompare(b.name, undefined, {
          numeric: true,
          sensitivity: "base",
        });
      if (sortBy === "name-desc")
        return b.name.localeCompare(a.name, undefined, {
          numeric: true,
          sensitivity: "base",
        });
      if (sortBy === "size-asc") return (a.size || 0) - (b.size || 0);
      if (sortBy === "size-desc") return (b.size || 0) - (a.size || 0);
      return 0;
    });
  }

  // ------------------------------------------------------------------------
  // Smart Empty States and Perfect Center Rendering (Empty vs No Match Fix)
  // ------------------------------------------------------------------------
  if (lazyFilteredItems.length === 0) {
    // First, change the grid layout to center alignment.
    grid.style.display = "flex";
    grid.style.flexDirection = "column";
    grid.style.alignItems = "center";
    grid.style.justifyContent = "center";
    grid.style.minHeight = "300px"; // This height will vertically center the box
    grid.style.width = "100%";

    // Check if the folder was really empty from the start
    // Find the real data of the current folder
    let rawCurrentItems = globalVaultTree;
    currentFolderNavigation.forEach((folderName) => {
      const targetFolder = rawCurrentItems.find(
        (item) => item.type === "folder" && item.name === folderName,
      );
      if (targetFolder && targetFolder.children) {
        rawCurrentItems = targetFolder.children;
      }
    });

    if (rawCurrentItems.length === 0) {
      // Condition A: The folder is really empty
      grid.innerHTML = `
                        <div style="text-align: center; color: #5f6368; padding: 20px;">
                            <div style="font-size: 50px; margin-bottom: 10px;">📂</div>
                            <div style="font-size: 16px; font-weight: 600; color: #3c4043;">This folder is empty</div>
                            <div style="font-size: 13px; color: #70757a; margin-top: 4px;">Upload or drop files here to fill it up.</div>
                        </div>
                    `;
    } else {
      // Condition B: The folder has items, but none matched the search or filter
      grid.innerHTML = `
                        <div style="text-align: center; color: #5f6368; padding: 20px;">
                            <div style="font-size: 50px; margin-bottom: 10px;">🔍</div>
                            <div style="font-size: 16px; font-weight: 600; color: #3c4043;">No matching files or folders found</div>
                            <div style="font-size: 13px; color: #70757a; margin-top: 4px;">Check your spelling or clear filters to try again.</div>
                        </div>
                    `;
    }

    if (loadTrigger) loadTrigger.style.display = "none";
    return;
  } else {
    // If items found, reset the grid layout to normal CSS grid
    grid.style.display = "grid";
    grid.style.gridTemplateColumns = "repeat(auto-fill, minmax(140px, 1fr))";
    grid.style.gap = "15px";
    grid.style.minHeight = "initial";
  }

  // 2. Virtual slicing (take out the limited sized items)
  const nextSlice = lazyFilteredItems.slice(
    lazyCurrentIndex,
    lazyCurrentIndex + LAZY_PAGE_SIZE,
  );
  lazyCurrentIndex += nextSlice.length;

  // ========================================================================
  // 📁 WINDOWS EXPLORER STYLE: फोल्डर्स अलग और फाइल्स अलग करें
  // ========================================================================
  const sliceFolders = nextSlice.filter(item => item.type === "folder");
  const sliceFiles = nextSlice.filter(item => item.type !== "folder");

  // 1. पहले सिर्फ फोल्डर्स रेंडर करें
  sliceFolders.forEach((item) => {
    const card = document.createElement("div");
    card.className = "file-card";
    card.innerHTML = `
        <div class="file-thumbnail-zone" style="background: #fff8e1; font-size: 45px;">📁</div>
        <div class="file-info">
            <span class="file-name" title="${item.name}" style="font-weight:600; color:#e65100;">${item.name}</span>
        </div>
    `;
    card.onclick = () => {
        const searchBar = document.getElementById("drive-search-input");
        if (searchBar) searchBar.value = "";
        currentFolderNavigation.push(item.name);
        renderCurrentFolderLevel(false);
    };
    grid.appendChild(card);
  });

  // 2. बीच में विंडोज़ स्टाइल हल्की सी डिवाइडर लाइन (अगर फोल्डर और फाइल दोनों हैं)
  if (sliceFolders.length > 0 && sliceFiles.length > 0) {
    const divider = document.createElement('div');
    divider.className = "explorer-divider";
    grid.appendChild(divider);
  }

  // 3. अब सिर्फ फाइल्स रेंडर करें
  sliceFiles.forEach((item) => {
    const card = document.createElement("div");
    card.className = "file-card";
    const icon = item.file_type === "pdf" ? "📄" : "🖼️";
    const thumbId = `thumb-${item.name.replace(/\s+/g, "-")}`;
    const displaySize = formatFileSize(item.size);

    card.innerHTML = `
        <div class="file-thumbnail-zone" id="${thumbId}">
            <div class="thumb-spinner"></div>
        </div>
        <div class="file-info" style="flex-direction: column; align-items: flex-start; gap: 2px;">
            <div style="display: flex; align-items: center; gap: 8px; width: 100%;">
                <span class="file-icon">${icon}</span>
                <span class="file-name" title="${item.name}" style="flex: 1;">${item.name}</span>
            </div>
            <span style="font-size: 10px; color: #5f6368; padding-left: 24px;">${displaySize}</span>
        </div>
    `;

    const relativeFilePath =
        currentFolderNavigation.length > 0
          ? currentFolderNavigation.join("/") + "/" + item.name
          : item.name;

    card.onclick = () => showIntegratedPreview(relativeFilePath, item.file_type, card);

    setTimeout(() => fetchAndRenderSingleThumbnail(relativeFilePath, item.file_type, thumbId), 5);
    grid.appendChild(card);
  });

  // 4. Scroll Observer Attachment (Infinite Scrolling Logic)
  if (loadTrigger) {
    if (lazyCurrentIndex < lazyFilteredItems.length) {
      loadTrigger.style.display = "block"; // If there are remaining items, show the loader.

      if (!lazyObserver) {
        // As soon as the loader box is 10% visible on the screen, the next page will load
        lazyObserver = new IntersectionObserver(
          (entries) => {
            if (entries[0].isIntersecting) {
              console.log("🔄 Near bottom. Fetching next lazy slice...");
              renderCurrentFolderLevel(true); // appendMode = true
            }
          },
          {
            root: document.querySelector(".category-view-pane"), // Our scroll container
            threshold: 0.1,
          },
        );
        lazyObserver.observe(loadTrigger);
      }
    } else {
      loadTrigger.style.display = "none"; // If all loaded, hide the loader
    }
  }
}

// ⬅️ Navigation Function for the Back Button (with Reset)
function navigateBackFolder() {
  if (currentFolderNavigation.length > 0) {
    currentFolderNavigation.pop();
    renderCurrentFolderLevel(false); // Fresh render of the new folder
  }
}

// ⬅️ Navigation Function for the Back Button (with Reset)
function navigateBackFolder() {
  if (currentFolderNavigation.length > 0) {
    currentFolderNavigation.pop();
    renderCurrentFolderLevel();
  }
}

// Thumbnail Generator (Now accepts dynamic 'thumbId' and 'relativeFilePath')
async function fetchAndRenderSingleThumbnail(
  relativeFilePath,
  fileType,
  thumbId,
) {
  const placeholder = document.getElementById(thumbId);
  if (!placeholder) return;

  // 🔍 स्टेप 1: चेक करो कि क्या यह फ़ाइल पहले से ही कैशे में है?
  if (thumbnailCache[relativeFilePath]) {
    placeholder.innerHTML = "";
    
    if (thumbnailCache[relativeFilePath].status === "protected") {
      // अगर पहले पता चल चुका है कि यह प्रोटेक्टेड है, तो सीधे ताला दिखाओ
      placeholder.innerHTML = `<div class="protected-badge">🔒 Protected</div>`;
    } else if (thumbnailCache[relativeFilePath].status === "error") {
      // अगर पहले एरर आया था, तो सीधा एरर दिखाओ
      placeholder.innerHTML = `<span style="font-size:11px;color:#888">Load Error</span>`;
    } else {
      // अगर सक्सेसफुल थंबनेल (चाहे PDF हो या Image) है, तो सीधा कैशे से लोड करो
      const cachedImg = document.createElement("img");
      cachedImg.src = thumbnailCache[relativeFilePath].dataUrl;
      placeholder.appendChild(cachedImg);
    }
    return; // 🎯 यहीं से वापस लौट जाओ, नीचे का नेटवर्क या PDF.js का हैवी कोड चलेगा ही नहीं!
  }

  // ---------------------------------------------------------------------
  // अगर कैशे में नहीं है, तो नीचे का ओरिजिनल लॉजिक पहली बार के लिए चलेगा
  // ---------------------------------------------------------------------
  const controller = new AbortController();
  activeThumbnailRequests.push(controller);

  try {
    const response = await fetch("/fetch-file-data", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        password: savedPassword,
        filename: relativeFilePath,
      }),
      signal: controller.signal,
    });

    if (!response.ok) return;
    const fileData = await response.json();
    
    // अगर HTML से एलिमेंट हट चुका है तो आगे प्रोसेस करने की जरूरत नहीं
    const currentPlaceholder = document.getElementById(thumbId);
    if (!currentPlaceholder) return;

    if (fileType === "pdf") {
      const binary = Uint8Array.from(atob(fileData.base64), (c) => c.charCodeAt(0));
      const loadingTask = pdfjsLib.getDocument({ data: binary.buffer });

      loadingTask.promise
        .then(async (pdf) => {
          const page = await pdf.getPage(1);
          const canvas = document.createElement("canvas");
          const viewport = page.getViewport({ scale: 0.35 });
          canvas.height = viewport.height;
          canvas.width = viewport.width;

          await page.render({
            canvasContext: canvas.getContext("2d"),
            viewport: viewport,
          }).promise;

          // 💾 कैशे में सेव करो: कैनवास को Base64 इमेज (DataURL) में बदलकर रख लो
          const finalDataUrl = canvas.toDataURL();
          thumbnailCache[relativeFilePath] = { status: "success", dataUrl: finalDataUrl };

          // यूआई पर रेंडर करो
          const finalImg = document.createElement("img");
          finalImg.src = finalDataUrl;
          currentPlaceholder.innerHTML = "";
          currentPlaceholder.appendChild(finalImg);
        })
        .catch((err) => {
          if (err.name === "PasswordException") {
            protectedFilesList[relativeFilePath] = true;
            // 💾 कैशे में रिकॉर्ड करो कि यह प्रोटेक्टेड है
            thumbnailCache[relativeFilePath] = { status: "protected" };
            currentPlaceholder.innerHTML = `<div class="protected-badge">🔒 Protected</div>`;
          } else {
            // 💾 कैशे में रिकॉर्ड करो कि यह करप्टेड या एरर वाली फाइल है
            thumbnailCache[relativeFilePath] = { status: "error" };
            currentPlaceholder.innerHTML = `<span style="font-size:11px;color:#888">Load Error</span>`;
          }
        });
    } else {
      // 🖼️ इमेज फाइल के लिए लॉजिक
      const srcDataUrl = `data:image/jpeg;base64,${fileData.base64}`;
      
      // 💾 इमेज को भी सीधे कैशे में डाल दो ताकि दोबारा फेच न करना पड़े
      thumbnailCache[relativeFilePath] = { status: "success", dataUrl: srcDataUrl };

      const img = document.createElement("img");
      img.src = srcDataUrl;
      img.onload = () => {
        currentPlaceholder.innerHTML = "";
        currentPlaceholder.appendChild(img);
      };
    }
  } catch (e) {
    if (e.name !== "AbortError") console.error(e);
  }
}

// ==========================================
// 🔠 Windows Start Menu Style A-Z Filter
// ==========================================
function toggleAZGrid() {
    const grid = document.getElementById('az-popup-grid');
    if (!grid) return;
    grid.classList.toggle('hidden');
    if (!grid.classList.contains('hidden')) {
        generateAZGrid();
    }
}

// ========================================================================
// 🖱️ Click Outside to Close: बाहर क्लिक करने पर A-Z पॉपअप बंद करना
// ========================================================================
document.addEventListener("click", function (event) {
    const azWrapper = document.querySelector(".az-filter-wrapper");
    const azPopup = document.getElementById("az-popup-grid");
    
    // अगर पॉपअप खुला हुआ है और क्लिक उस बटन या ग्रिड के बाहर हुआ है
    if (azPopup && !azPopup.classList.contains("hidden") && azWrapper) {
        if (!azWrapper.contains(event.target)) {
            azPopup.classList.add("hidden"); // पॉपअप छुपा दें
        }
    }
});

function generateAZGrid() {
    const grid = document.getElementById('az-popup-grid');
    if (!grid) return;
    grid.innerHTML = ""; 

    const alphabet = "#ABCDEFGHIJKLMNOPQRSTUVWXYZ".split("");
    const itemsToScan = window.currentDirectoryItemsRaw || globalVaultTree;
    
    // वर्तमान एक्टिव फ़ोल्डर के डेटा से शुरुआती अक्षरों का सेट बनाएं
    const existingInitials = new Set(
        itemsToScan.map(item => (item.name || "").trim().charAt(0).toUpperCase())
    );

    alphabet.forEach(letter => {
        const span = document.createElement('span');
        span.textContent = letter;
        span.className = 'az-letter';

        // चेक करें कि क्या इस अक्षर से कोई आइटम सच में है?
        const isAvailable = (letter === '#') 
            ? itemsToScan.some(item => /[^A-Z]/i.test((item.name || "").trim().charAt(0)))
            : existingInitials.has(letter);

        if (isAvailable) {
            span.onclick = () => {
                filterByLetter(letter);
                toggleAZGrid(); 
            };
        } else {
            span.classList.add('disabled'); // विंडोज़ की तरह डिसेबल (ग्रे) लुक
        }
        grid.appendChild(span);
    });
}

function filterByLetter(letter) {
    const itemsToFilter = window.currentDirectoryItemsRaw || globalVaultTree;
    let filtered = [];

    if (letter === '#') {
        filtered = itemsToFilter.filter(item => /[^A-Z]/i.test((item.name || "").trim().charAt(0)));
    } else {
        filtered = itemsToFilter.filter(item => (item.name || "").trim().toUpperCase().startsWith(letter));
    }

    // आपके लेज़ी लोडर इंजन को चकमा देने के लिए 'lazyFilteredItems' को बाईपास करें
    lazyFilteredItems = filtered;
    
    // ग्रिड साफ़ करके सिर्फ फ़िल्टर्ड डेटा रेंडर करने के लिए इंजन को ट्रिगर करें
    const grid = document.getElementById("main-explorer-grid") || document.getElementById("category-view-pane");
    if (grid) grid.innerHTML = "";
    lazyCurrentIndex = 0;
    
    // appendMode = true देकर रेंडर मार दें ताकि सॉर्टिंग दोबारा न चले
    renderCurrentFolderLevel(true); 
}