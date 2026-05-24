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
async function showIntegratedPreview(filename, type, cardElement, filePassword = "") {
  activeThumbnailRequests.forEach((controller) => controller.abort());
  activeThumbnailRequests = [];

  // 🎯 FIX 5: Activate outer column container workspace expansion smoothly
  const colWrapper = document.querySelector(".integrated-preview-column");
  if (colWrapper) colWrapper.classList.add("active-pane");

  const previewPane = document.getElementById("integrated-preview-pane");
  const titleDisplay = document.getElementById("preview-filename-display");
  const pagesArea = document.getElementById("preview-raster-pages-area");
  const printBtn = document.getElementById("print-action-btn");
  const printerSelect = document.getElementById("printer-select-area");

  if (!previewPane || !pagesArea) return;

  document.querySelectorAll(".file-card").forEach((c) => c.classList.remove("active"));
  cardElement.classList.add("active");

  if (printBtn) printBtn.style.display = "block";
  if (printerSelect) printerSelect.style.display = "block";
  if (titleDisplay) titleDisplay.innerText = filename.split("/").pop();

  decryptedCanvasCache = [];
  pagesArea.innerHTML = `<div class="stream-loader" style="padding:20px;text-align:center;font-size:13px;color:#1a73e8;"><span>⚡ Streaming secure bytes...</span></div>`;

  try {
    const response = await fetch("/fetch-file-data", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ password: savedPassword, filename: filename, session_id: currentSessionId }),
    });

    if (!response.ok) throw new Error("Stream connection failed.");
    const fileData = await response.json();

    activeFile.name = filename;
    activeFile.type = type;
    activeFile.base64 = fileData.base64;
    activeFile.binary = Uint8Array.from(atob(fileData.base64), (c) => c.charCodeAt(0));

    if (type === "pdf") {
      const loadingTask = pdfjsLib.getDocument({ data: activeFile.binary.buffer.slice(0), password: filePassword });
      loadingTask.promise.then(async (pdf) => {
          pagesArea.innerHTML = "";
          for (let pageNum = 1; pageNum <= pdf.numPages; pageNum++) {
            const page = await pdf.getPage(pageNum);
            const canvas = document.createElement("canvas");
            canvas.className = "raster-page-preview";
            const viewport = page.getViewport({ scale: 1.2 });
            canvas.height = viewport.height; canvas.width = viewport.width;
            
            await page.render({ canvasContext: canvas.getContext("2d"), viewport: viewport }).promise;
            pagesArea.appendChild(canvas);

            const printCanvas = document.createElement("canvas");
            const printViewport = page.getViewport({ scale: 2.5 });
            printCanvas.height = printViewport.height; printCanvas.width = printViewport.width;
            await page.render({ canvasContext: printCanvas.getContext("2d"), viewport: printViewport }).promise;
            decryptedCanvasCache.push(printCanvas);
          }
      }).catch((err) => {
          if (err.name === "PasswordException") {
            protectedFilesList[filename] = true;
            pagesArea.innerHTML = `<div class="file-lock-form" style="padding:20px;">
                                    <input type="password" id="file-inner-pass" placeholder="Enter File Password" style="width:100%;padding:8px;margin-bottom:8px;">
                                    <button class="btn primary-submit-btn" onclick="submitFilePassword('${filename}', this)">Decrypt</button>
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
    pagesArea.innerHTML = `<p style='color:red; padding:10px;'>Error: ${error.message}</p>`;
  }
}

function closePreviewPane() {
  // 🎯 FIX 5: Completely shrink and reset right side column width to restore folder grid scale
  const colWrapper = document.querySelector(".integrated-preview-column");
  if (colWrapper) colWrapper.classList.remove("active-pane");
  
  document.querySelectorAll(".file-card").forEach((c) => c.classList.remove("active"));
  activeFile = { name: null, type: null, base64: null, binary: null };
  decryptedCanvasCache = [];
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

// Secret Key Manual Login (with client-side validation)
async function unlockVault() {
  const passwordInput = document.getElementById("secret-key");
  if (!passwordInput) return;

  // trim from input
  const password = passwordInput.value.trim();
  savedPassword = password;

  // ==========================================
  // Client-side validation gateway
  // ==========================================
  
  // Rule 1: Is input empty?
  if (password === "") {
    showToast("Please enter your secret key.", "error");
    // passwordInput.focus();
    return;
  }

  // ==========================================
  // Network request to validate and fetch vault data
  // ==========================================
  try {
    const response = await fetch("/fetch-vault-list", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ password: password }),
    });

    if (!response.ok) { 
      showToast("Incorrect secret key.", "error"); 
      return; 
    }
    const data = await response.json();

    // Show a beautiful success toast
    showToast("Welcome!", "success");

    document.getElementById("auth-container").style.display = "none";
    document.getElementById("file-manager-dashboard").style.display = "flex";

    globalVaultTree = data.tree;
    currentFolderNavigation = [];
    renderCurrentFolderLevel();

    // DIRECT UI SWAP: Hide auth, show profile menu, show responsive dashboard
    const profileTrigger = document.querySelector(".profile-dropdown-wrapper");
    if (profileTrigger) profileTrigger.style.display = "block";

    // Trigger mobile scanner feature check upon manual authorization
    initializeMobileScannerFeatures();

    //FIX: Start the background session lifecycle observer on the desktop app instance
    startDesktopActiveSessionMonitor();
  } catch (error) {
    showToast("Error: " + error.message, "error");
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

    // As soon as the folder data has been filtered and is ready, immediately sync it for A-Z.
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

  // 2. A subtle, Windows-style divider line in the middle (if both folders and files are present).
  if (sliceFolders.length > 0 && sliceFiles.length > 0) {
    const divider = document.createElement('div');
    divider.className = "explorer-divider";
    grid.appendChild(divider);
  }

  // 3. Now, render only the files.
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

  // Step 1: Check if this file is already in the cache.
  if (thumbnailCache[relativeFilePath]) {
    placeholder.innerHTML = "";
    
    if (thumbnailCache[relativeFilePath].status === "protected") {
      // If it's already known to be protected, show the lock directly
      placeholder.innerHTML = `<div class="protected-badge">🔒 Protected</div>`;
    } else if (thumbnailCache[relativeFilePath].status === "error") {
      // If an error occurred previously, show the error directly
      placeholder.innerHTML = `<span style="font-size:11px;color:#888">Load Error</span>`;
    } else {
      // If a successful thumbnail (whether PDF or Image) is available, load it directly from the cache
      const cachedImg = document.createElement("img");
      cachedImg.src = thumbnailCache[relativeFilePath].dataUrl;
      placeholder.appendChild(cachedImg);
    }
    return; // Turn back right here—the network down below, or the heavy code of PDF.js, simply won't run!
  }

  // ---------------------------------------------------------------------
  // If it is not in the cache, the original logic below will execute for the first time.
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
        session_id: currentSessionId // Make sure to add this line so that the thumbnails don't return a 403 error.
      }),
      signal: controller.signal,
    });

    if (!response.ok) return;
    const fileData = await response.json();
    
    // If the element has been removed from the HTML, there is no need to proceed further.
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

          // Save to Cache: Convert the canvas into a Base64 image (DataURL) and store it.
          const finalDataUrl = canvas.toDataURL();
          thumbnailCache[relativeFilePath] = { status: "success", dataUrl: finalDataUrl };

          // Render on UI
          const finalImg = document.createElement("img");
          finalImg.src = finalDataUrl;
          currentPlaceholder.innerHTML = "";
          currentPlaceholder.appendChild(finalImg);
        })
        .catch((err) => {
          if (err.name === "PasswordException") {
            protectedFilesList[relativeFilePath] = true;
            // Save to Cache: Record that it is protected
            thumbnailCache[relativeFilePath] = { status: "protected" };
            currentPlaceholder.innerHTML = `<div class="protected-badge">🔒 Protected</div>`;
          } else {
            // Save to Cache: Record that it is a corrupted or error file
            thumbnailCache[relativeFilePath] = { status: "error" };
            currentPlaceholder.innerHTML = `<span style="font-size:11px;color:#888">Load Error</span>`;
          }
        });
    } else {
      // Logic for Image Files
      const srcDataUrl = `data:image/jpeg;base64,${fileData.base64}`;
      
      // Put the image directly into the cache as well, so that it doesn't have to be fetched again.
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
// Click Outside to Close: Closing the A-Z Popup by Clicking Outside
// ========================================================================
document.addEventListener("click", function (event) {
    const azWrapper = document.querySelector(".az-filter-wrapper");
    const azPopup = document.getElementById("az-popup-grid");
    
    // If the popup is open and a click occurs outside that button or grid...
    if (azPopup && !azPopup.classList.contains("hidden") && azWrapper) {
        if (!azWrapper.contains(event.target)) {
            azPopup.classList.add("hidden"); // Hide the popup
        }
    }
});

function generateAZGrid() {
    const grid = document.getElementById('az-popup-grid');
    if (!grid) return;
    grid.innerHTML = ""; 

    const alphabet = "#ABCDEFGHIJKLMNOPQRSTUVWXYZ".split("");
    const itemsToScan = window.currentDirectoryItemsRaw || globalVaultTree;
    
    // Create a set of initial letters from the data in the current active folder.
    const existingInitials = new Set(
        itemsToScan.map(item => (item.name || "").trim().charAt(0).toUpperCase())
    );

    alphabet.forEach(letter => {
        const span = document.createElement('span');
        span.textContent = letter;
        span.className = 'az-letter';

        // Check if there is actually an item with this letter
        const isAvailable = (letter === '#') 
            ? itemsToScan.some(item => /[^A-Z]/i.test((item.name || "").trim().charAt(0)))
            : existingInitials.has(letter);

        if (isAvailable) {
            span.onclick = () => {
                filterByLetter(letter);
                toggleAZGrid(); 
            };
        } else {
            span.classList.add('disabled'); // Windows-like disabled (greyed out) look
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

    // Bypass 'lazyFilteredItems' to trick your lazy loader engine
    lazyFilteredItems = filtered;
    
    // Trigger the engine to clear the grid and render only the filtered data.
    const grid = document.getElementById("main-explorer-grid") || document.getElementById("category-view-pane");
    if (grid) grid.innerHTML = "";
    lazyCurrentIndex = 0;
    
    // Set appendMode` = true, and trigger the render so that the sorting does not run again.
    renderCurrentFolderLevel(true); 
}

// ========================================================================
// 📱 Smart Lazy QR Code Login Engine (Traffic Optimized & Synced)
// ========================================================================
let qrPollingInterval = null;
let currentSessionId = null;

// 1. The main function for requesting a new QR session from the server.
async function generateNewQR() {
    const qrDisplay = document.getElementById('qr-code-display');
    if (!qrDisplay) return;

    qrDisplay.innerHTML = "<small style='color:#666;'>Generating Secure QR...</small>";

    try {
        const response = await fetch('/generate-qr-session');
        const data = await response.json();
        
        if (data.session_id && data.qr_image) {
            currentSessionId = data.session_id;
            // Set the QR image on the screen
            qrDisplay.innerHTML = `<img src="${data.qr_image}" alt="Scan Me" style="width:100%; height:100%; object-fit:contain;">`;
        }
    } catch (e) {
        console.error("Error generating QR Code:", e);
        qrDisplay.innerHTML = "<small style='color:red;'>Failed to load QR</small>";
    }
}

// 🎯 2. 'initiateQRLogin' Wrapper function to fix the error
// Now if initiateQRLogin() is called anywhere in the project, it won't crash!
async function initiateQRLogin() {
    await generateNewQR();
}

// 3. 🟢 Function to start polling (when user focuses on QR)
function startQRPolling() {
    const statusText = document.getElementById('qr-status-text');
    if (statusText) {
        statusText.innerText = "⚡ Scanner Active. Waiting for scan...";
        statusText.style.color = "#2563eb";
    }

    // If a loop is already running, clear it to prevent duplicates
    if (qrPollingInterval) clearInterval(qrPollingInterval);
    
    // Start polling the backend for the status every 2 seconds.
    qrPollingInterval = setInterval(checkQRAuthenticationStatus, 2000);
    console.log("▶️ QR Polling Started...");
}

// 4. Function to completely stop polling (when user goes to key-login)
function stopQRPolling() {
    if (qrPollingInterval) {
        clearInterval(qrPollingInterval);
        qrPollingInterval = null;
        console.log("⏸️ QR Polling Stopped...");
    }
    
    const statusText = document.getElementById('qr-status-text');
    if (statusText) {
        statusText.innerText = "Waiting for response...";
        statusText.style.color = "#64748b";
    }
}

// 5. Desktop Unlocking Real Backend Checker
async function checkQRAuthenticationStatus() {
    if (!currentSessionId) return;
    try {
        const response = await fetch('/verify-private-scan/' + currentSessionId);
        if (!response.ok) return; 
        const data = await response.json();
        
        // When the mobile scan is 100% successful:
        if (data.success) {
            stopQRPolling(); // Stop the polling loop immediately
            if (qrPollingInterval) {
                clearInterval(qrPollingInterval);
                qrPollingInterval = null;
            }
            console.log("Authentication successful! Stopped QR Polling permanently.");
            
            const qrDisplay = document.getElementById('qr-code-display');
            // const statusText = document.getElementById('qr-status-text');
            
            // if (statusText) {
            //     statusText.innerText = "Scan Successful! Verifying...";
            //     statusText.style.color = "#16a34a"; // Change text color to green
            // }

            // 🎯 Replace QR code with a large animated success tick
            if (qrDisplay) {
                qrDisplay.innerHTML = `
                    <div class="qr-success-wrapper" style="display:flex; flex-direction:column; align-items:center; justify-content:center; height:100%; width:100%;">
                        <svg class="animated-checkmark" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 52 52" style="width:80px; height:80px; border-radius:50%; display:block; stroke-width:3; stroke:#22c55e; stroke-miterlimit:10; box-shadow:inset 0px 0px 0px #22c55e; animation:fill .4s ease-in-out .4s forwards, scale .3s ease-in-out .9s both;">
                            <circle class="animated-checkmark__circle" cx="26" cy="26" r="25" fill="none" style="stroke-dasharray:166; stroke-dashoffset:166; stroke-width:3; stroke-miterlimit:10; stroke:#22c55e; fill:none; animation:stroke 0.6s cubic-bezier(0.65, 0, 0.45, 1) forwards;"/>
                            <path class="animated-checkmark__check" fill="none" d="M14.1 27.2l7.1 7.2 16.7-16.8" style="transform-origin:50% 50%; stroke-dasharray:48; stroke-dashoffset:48; animation:stroke 0.3s cubic-bezier(0.65, 0, 0.45, 1) 0.6s forwards;"/>
                        </svg>
                        <style>
                            @keyframes stroke { 100% { stroke-dashoffset: 0; } }
                            @keyframes scale { 0%, 100% { transform: none; } 50% { transform: scale3d(1.1, 1.1, 1); } }
                            @keyframes fill { 100% { box-shadow: inset 0px 0px 0px 40px rgba(34, 197, 94, 0.1); } }
                        </style>
                    </div>
                `;
            }

            // Fetch vault data (Vault List) from the backend
            const vaultResponse = await fetch("/fetch-vault-list", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ session_id: currentSessionId }), 
            });
            if (!vaultResponse.ok) return;
            const vaultData = await vaultResponse.json();
            
            // Wait for 1.5 seconds (1500ms) so that the user sees the large tick animation.
            setTimeout(() => {
                // Hide the login screen and show the file explorer dashboard
                document.getElementById("auth-container").style.display = "none";
                document.getElementById("file-manager-dashboard").style.display = "flex";

                // Setup data and rendering
                globalVaultTree = vaultData.tree; 
                currentFolderNavigation = []; 
                renderCurrentFolderLevel();
                showToast("Welcome!", "success");

                // Trigger mobile scanner feature check upon QR authorization
                initializeMobileScannerFeatures();

                // 🎯 GLOBAL MEMORY LOCK: Explicitly preserve the active token in memory before firing the monitor loop
                // Without this line, currentSessionId becomes undefined after layout transitions!
                if (!currentSessionId && data.session_id) {
                    currentSessionId = data.session_id;
                }

                // 🎯 FIX: Explicitly pass the active token directly into the monitor to eliminate global variable race conditions
                startDesktopActiveSessionMonitor(currentSessionId);
            }, 1500);
        }
    } catch (e) { 
        console.error("Error polling QR status:", e); 
    }
}

// ========================================================================
// 👤 Profile Dropdown Menu Toggle Engine
// ========================================================================
function toggleProfileDropdown() {
    const dropdown = document.getElementById("profile-menu-dropdown");
    if (!dropdown) return;
    
    if (dropdown.style.display === "none" || dropdown.style.display === "") {
        dropdown.style.display = "flex";
    } else {
        dropdown.style.display = "none";
    }
}

// Close profile dropdown cleanly if user clicks anywhere outside the trigger zone
document.addEventListener("click", function (event) {
    const dropdown = document.getElementById("profile-menu-dropdown");
    const avatar = document.querySelector(".profile-avatar-trigger");
    
    if (dropdown && dropdown.style.display === "flex" && avatar) {
        if (!avatar.contains(event.target) && !dropdown.contains(event.target)) {
            dropdown.style.display = "none";
        }
    }
});

// ========================================================================
// 📱 WhatsApp Web Style: Dashboard Mobile Scanner Engine
// ========================================================================
let dashboardHtml5QrCode = null;

// Check device environment and conditionally expose desktop linker features
// Mobile Device Optimization & Desktop Linker Feature Trigger
function initializeMobileScannerFeatures() {
    const mobileLinkBtn = document.getElementById("mobile-scan-trigger-btn");
    const mobileDisconnectBtn = document.getElementById("mobile-disconnect-desktop-btn");
    if (!mobileLinkBtn) return;

    // 🎯 FIX: Robust checking for mobile layout using window width and user agent
    const isMobileLayout = window.innerWidth <= 900 || /Mobi|Android|iPhone/i.test(navigator.userAgent);

    if (isMobileLayout) {
        // Force fully visible display override for mobile users inside the profile menu dropdown
        mobileLinkBtn.style.setProperty('display', 'block', 'important');
        console.log("Mobile viewport recognized: Desktop Linking Module Activated.");

        // 🎯 FIX: Expose the disconnect action trigger explicitly for verified smartphone environments
        if (mobileDisconnectBtn) mobileDisconnectBtn.style.setProperty('display', 'block', 'important');

        // Target and remove the secondary QR toggle action elements strictly for native security viewports
        const authContainer = document.getElementById("auth-container");
        if (authContainer) {
            // Locate the "Scan QR Instead" button on the front side card
            const qrToggleBtn = authContainer.querySelector(".auth-card-front .secondary-btn");
            // Locate the descriptive text separator node
            const textDivider = authContainer.querySelector(".auth-card-front .auth-divider-text");

            if (qrToggleBtn) qrToggleBtn.remove(); // Safely purge the element from DOM
            if (textDivider) textDivider.remove(); // Safely purge the element from DOM
            console.log("Mobile context verified dynamically via JS: Purged unused QR gateway button vectors.");
        }
    } else {
        // Keep hidden on actual native desktop monitors
        mobileLinkBtn.style.setProperty('display', 'none', 'important');
        if (mobileDisconnectBtn) mobileDisconnectBtn.style.setProperty('display', 'none', 'important');
    }
}
function _initializeMobileScannerFeatures() {
    const isMobileDevice = /Android|webOS|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini/i.test(navigator.userAgent);
    
    if (isMobileDevice) {
        const scanBtn = document.getElementById("mobile-scan-trigger-btn");
        if (scanBtn) {
            scanBtn.style.display = "flex"; // Show link option inside dropdown if on mobile
        }
    }
}

// 1. Open Modal Popup and initialize camera streams from dropdown menu trigger
function openMobileScannerFromDashboard() {
    const dropdown = document.getElementById("profile-menu-dropdown");
    if (dropdown) dropdown.style.display = "none"; // Close dropdown first

    const modal = document.getElementById('mobile-dashboard-scanner-modal');
    const statusText = document.getElementById('mobile-dashboard-scanned-status');
    if (!modal) return;

    modal.style.display = 'flex';
    if (statusText) statusText.innerText = "Requesting camera permission...";

    dashboardHtml5QrCode = new Html5Qrcode("mobile-dashboard-reader");
    const config = { fps: 10, qrbox: { width: 250, height: 250 } };

    dashboardHtml5QrCode.start({ facingMode: "environment" }, config, onDashboardScanSuccess)
    .then(() => {
        if (statusText) statusText.innerText = "Ready to scan desktop QR code...";
    })
    .catch(err => {
        if (statusText) statusText.innerHTML = "<span style='color:red;'>Camera access denied!</span>";
    });
}

// 2. Close scanner modal popup dialog and terminate streaming video tracks cleanly
function closeMobileScannerFromDashboard() {
    const modal = document.getElementById('mobile-dashboard-scanner-modal');
    if (dashboardHtml5QrCode && dashboardHtml5QrCode.isScanning) {
        dashboardHtml5QrCode.stop().then(() => {
            if (modal) modal.style.display = 'none';
        });
    } else {
        if (modal) modal.style.display = 'none';
    }
}

// 3. Callback execution upon tracking valid QR identity token from desktop
async function onDashboardScanSuccess(decodedText, decodedResult) {
    const statusText = document.getElementById('mobile-dashboard-scanned-status');
    if (statusText) statusText.innerText = "Authenticating desktop session...";
    
    await dashboardHtml5QrCode.stop();

    try {
        const res = await fetch('/verify-private-scan/' + decodedText, { method: 'POST' });
        if (res.ok) {
            // FIX: Store the scanned token string into the mobile's currentSessionId memory pool
            currentSessionId = decodedText; 
            console.log("Mobile paired successfully with Desktop Session ID:", currentSessionId);
            if (statusText) statusText.innerHTML = "<span style='color:green;'>Desktop authorization successful!</span>";
            showToast("Desktop authenticated successfully!", "success");
            
            setTimeout(() => { 
                document.getElementById('mobile-dashboard-scanner-modal').style.display = 'none'; 
            }, 1200);
        } else {
            if (statusText) statusText.innerHTML = "<span style='color:red;'>Invalid or expired QR token!</span>";
            showToast("Authentication failed: Invalid QR token", "error");
        }
    } catch (e) {
        if (statusText) statusText.innerText = "Network transmission error!";
        console.error(e);
    }
}

// ========================================================================
// DOM Ready Hook: Always live polling without any mouse hassle
// ========================================================================
document.addEventListener("DOMContentLoaded", () => {
    if (document.getElementById('auth-container')) {
        
        initializeMobileScannerFeatures();
        
        // 2. Without the fuss of mouse interactions, immediately start the polling loop
        // after 2 seconds so that it continuously queries the backend to check whether
        // the mobile device has scanned.
        // 🎯 FIX: Clear the automatic instant call of generateNewQR from here to block bootup network flood
    // Only configure responsive device assets on load
    try {
        initializeMobileScannerFeatures();
    } catch (mobileOptimizationError) {
        console.error("Non-blocking error during mobile layout optimization loop:", mobileOptimizationError);
    }
    }
});


// ========================================================================
// 🔄 Card Rotation Toggle Engine
// ========================================================================
function rotateCard(shouldFlip) {
    const cardInner = document.getElementById('flip-card-inner');
    if (!cardInner) return;
    
    if (shouldFlip) {
        cardInner.classList.add('flipped');
        // 🎯 FIX: Lazy load the session QR token and activate polling loops ONLY upon explicit button tap action
        generateNewQR().then(() => {
            startQRPolling();
        });
    } else {
        cardInner.classList.remove('flipped');
        stopQRPolling();
    }
}

// Premium HTML glassmorphic toast notification engine (Bottom-Center Aligned)
function showToast(message, type = "error") {
    const container = document.getElementById("custom-toast-container");
    if (!container) return;

    const toast = document.createElement("div");
    toast.style.width = "100%";
    toast.style.padding = "0 20px"; // Adds standard edge safety padding for small mobile wraps
    toast.style.pointerEvents = "auto"; // Restores click events specifically for the individual toast element

    const isSuccess = type === "success";
    const borderColor = isSuccess ? "#10b981" : "#ef4444";
    const bgColor = isSuccess ? "rgba(240, 253, 250, 0.95)" : "rgba(254, 242, 242, 0.95)";
    const textColor = isSuccess ? "#065f46" : "#991b1b";

    const currentIcon = isSuccess 
        ? `<svg style="width:20px; height:20px; color:#10b981; flex-shrink:0;" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2.5" d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z"></path></svg>`
        : `<svg style="width:20px; height:20px; color:#ef4444; flex-shrink:0;" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2.5" d="M12 8v4m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z"></path></svg>`;

    // 🎯 ANIMATION FIX: Initial state starts down below the boundary screen frame (translateY)
    toast.innerHTML = `
        <div class="modern-toast-box" style="background:${bgColor}; color:${textColor}; border-left:5px solid ${borderColor}; padding:14px 20px; border-radius:8px; display:flex; align-items:center; gap:12px; width:100%; max-width:360px; margin:0 auto; box-shadow:0 10px 25px rgba(0,0,0,0.1); backdrop-filter:blur(8px); transform:translateY(150%); transition:transform 0.4s cubic-bezier(0.175, 0.885, 0.32, 1.275); position:relative;">
            <div>${currentIcon}</div>
            <div style="flex:1; line-height:1.4; text-align:left; font-size:13px;">${message}</div>
            <button style="background:none; border:none; color:${textColor}; font-weight:bold; cursor:pointer; font-size:16px; padding:0 0 0 4px;" onclick="this.parentElement.parentElement.remove()">&times;</button>
        </div>
    `;
    container.appendChild(toast);
    
    // Smoothly lift up the active toast box slice context view
    setTimeout(() => { 
        const box = toast.querySelector(".modern-toast-box"); 
        if (box) box.style.transform = "translateY(0)"; 
    }, 50);
    
    // Slide down and dismiss the element frame context once timer expires safely
    setTimeout(() => { 
        const box = toast.querySelector(".modern-toast-box"); 
        if (box) { 
            box.style.transform = "translateY(150%)"; 
            setTimeout(() => { toast.remove(); }, 400); 
        } 
    }, 4500);
}

// 🎯 FIX: Remote Desktop session execution termination transmitter (Triggers from Mobile App)
async function remoteKillDesktopSession() {
    // Collect the dynamic active link session identifier string from storage or memory
    if (!currentSessionId) {
        showToast("No active linked desktop session detected.", "error");
        return;
    }
    
    if (!confirm("Are you sure you want to disconnect and lock the linked desktop session?")) return;

    try {
        // Post a termination request payload directly to the backend stream checkpoint
        const response = await fetch('/terminate-desktop-session', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ session_id: currentSessionId })
        });

        if (response.ok) {
            showToast("Desktop session locked successfully.", "success");
            const dropdown = document.getElementById("profile-menu-dropdown");
            if (dropdown) dropdown.style.display = "none";
        } else {
            showToast("Failed to transmit disconnect sequence.", "error");
        }
    } catch (error) {
        console.error("Transmission break during remote kill request:", error);
    }
}

// 🎯 FIX: Continuous background tracker to listen for remote kill commands (Runs on Desktop after login)
function startDesktopActiveSessionMonitor() {
    if (!currentSessionId) return;
    
    const sessionTrackerLoop = setInterval(async () => {
        try {
            // Poll the backend validation checkpoint to see if this unique instance is still authorized
            const response = await fetch('/verify-private-scan/' + currentSessionId);
            if (!response.ok) return;
            const data = await response.json();
            
            // If the backend drops the success state or flags a termination request token
            if (!data.success) {
                clearInterval(sessionTrackerLoop); // Kill the background loop observer immediately
                console.log("Remote termination signal intercepted. Enforcing instance hard lock.");
                
                // Force state reset and send user context back to the cryptographic gateway screen
                showToast("Session disconnected via remote device controller.", "error");
                setTimeout(() => {
                    location.reload(); // Instantly purges cache memory and restores default lock screen
                }, 1500);
            }
        } catch (e) {
            console.error("Silent error during active session tracking loop:", e);
        }
    }, 3000); // Poll every 3 seconds silently in the background
}