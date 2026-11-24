// Social Manager admin panel: the only script, loaded from our own origin
// (the CSP allows 'self' and nothing inline). Pure progressive enhancement:
// every form still works without it.
//
// While a POST form is being submitted, its submit button is disabled and
// shows a spinner, so a slow "Send" can't be clicked twice. (The server is
// already safe against double sends; this is for the person clicking.)
document.addEventListener("submit", (event) => {
  const form = event.target;
  if (!(form instanceof HTMLFormElement) || form.method.toLowerCase() !== "post") return;
  if (form.dataset.submitting) {
    event.preventDefault();
    return;
  }
  form.dataset.submitting = "1";
  const button = event.submitter || form.querySelector("button:not([type=button])");
  if (!button) return;
  // Disable after the browser has taken the submission, or it would be cancelled.
  setTimeout(() => {
    button.disabled = true;
    button.setAttribute("aria-busy", "true");
    if (button.dataset.pending) button.textContent = button.dataset.pending;
  }, 0);
});

// Coming back with the Back button restores the page from cache with the
// button still disabled; reset it.
window.addEventListener("pageshow", (event) => {
  if (!event.persisted) return;
  document.querySelectorAll("form[data-submitting]").forEach((form) => delete form.dataset.submitting);
  document.querySelectorAll("button[aria-busy]").forEach((button) => {
    button.disabled = false;
    button.removeAttribute("aria-busy");
    if (button.dataset.label) button.textContent = button.dataset.label;
  });
});
