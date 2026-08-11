const [iframe, urlInput, backBtn, forwardBtn, refreshBtn] = [
    "safari-iframe", "safari-url", "safari-back", "safari-forward", "safari-refresh",
].map((id) => document.getElementById(id));

let history = ["https://mengobs.github.io/Webintosh-Desktop"];
let historyIndex = 0;

function navigateTo(url) {
    if (!/^https?:\/\//.test(url)) url = "https://" + url;
    iframe.src = url;
    urlInput.value = url;

    if (historyIndex < history.length - 1) {
        history = history.slice(0, historyIndex + 1);
    }
    history.push(url);
    historyIndex = history.length - 1;
    updateButtons();
}

function goTo(index) {
    if (index < 0 || index >= history.length) return;
    historyIndex = index;
    iframe.src = history[index];
    urlInput.value = history[index];
    updateButtons();
}

function updateButtons() {
    backBtn.disabled = historyIndex <= 0;
    forwardBtn.disabled = historyIndex >= history.length - 1;
}

urlInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter") navigateTo(urlInput.value);
});

backBtn.addEventListener("click", () => goTo(historyIndex - 1));
forwardBtn.addEventListener("click", () => goTo(historyIndex + 1));
refreshBtn.addEventListener("click", () => iframe.src = iframe.src);

updateButtons();