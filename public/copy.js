// Copy buttons: copy the text of the element named by data-copy.
document.addEventListener("click", async (event) => {
  const button = event.target.closest("button[data-copy]");
  if (!button) return;
  const source = document.getElementById(button.dataset.copy);
  if (!source) return;
  const label = button.textContent;
  // The buttons carry an aria-label, so their changing text isn't announced:
  // report the result through the page's status region instead.
  const status = document.getElementById("copy-status");
  const announce = (text) => { if (status) status.textContent = text; };
  try {
    await navigator.clipboard.writeText(source.textContent.trim());
    button.textContent = "Copied";
    announce("Copied to the clipboard");
  } catch {
    // Clipboard unavailable (old browser, insecure context): select the text instead.
    const range = document.createRange();
    range.selectNodeContents(source);
    const sel = window.getSelection();
    sel.removeAllRanges();
    sel.addRange(range);
    button.textContent = "Selected";
    announce("Command selected; press Command-C to copy it");
  }
  setTimeout(() => { button.textContent = label; announce(""); }, 1600);
});
