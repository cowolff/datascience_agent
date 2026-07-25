// Terms-of-Service gate (see templates/_tos_modal.html for the markup and
// the matching inline script that shows the overlay synchronously before
// this deferred module loads). Handles the interactive part only: enabling
// "Agree" once the checkbox is ticked, persisting acceptance, and the
// "Decline" dead end. Bump STORAGE_KEY's version suffix (here and in the
// partial's inline script) to force everyone to re-accept after a material
// change to the terms.

const STORAGE_KEY = "bench.tos.v1";

const overlay = document.getElementById("tos-overlay");
const checkbox = document.getElementById("tos-checkbox");
const agreeBtn = document.getElementById("tos-agree");
const declineBtn = document.getElementById("tos-decline");
const declinedMsg = document.getElementById("tos-declined-msg");

if (overlay && checkbox && agreeBtn && declineBtn) {
  checkbox.addEventListener("change", () => {
    agreeBtn.disabled = !checkbox.checked;
  });

  agreeBtn.addEventListener("click", () => {
    if (!checkbox.checked) return;
    try {
      localStorage.setItem(STORAGE_KEY, "1");
    } catch (e) {}
    overlay.classList.remove("flex");
    overlay.classList.add("hidden");
    document.body.classList.remove("overflow-hidden");
  });

  declineBtn.addEventListener("click", () => {
    checkbox.checked = false;
    checkbox.disabled = true;
    agreeBtn.disabled = true;
    declineBtn.disabled = true;
    declinedMsg?.classList.remove("hidden");
  });
}
