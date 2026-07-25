// The browser widget for human-in-the-loop tools (ask_user/ask_choice/
// confirm and their presets — plans/human-in-the-loop-tools.md §3). Unlike
// render/table.js and render/chart.js, which render an already-resolved
// result, this renders while the tool call is still *pending*: workbench.js's
// requestInput provider calls renderPromptCard() the moment an interact
// tool's handler calls ctx.requestInput, and the two callbacks below resolve
// the very Promise the agent loop is awaiting — answering (or declining)
// literally unblocks the paused tool call.
//
// spec: { kind: "text"|"choice"|"confirm", question, options?, allowMultiple?,
//         why?, title? }
// onAnswer(value) — resolves the pending call with the user's answer
// onDecline() — resolves it as "let the agent decide" (answered: false)

import { el } from "./dom.js";

function titleFor(spec) {
  if (spec.title) return spec.title;
  if (spec.kind === "choice") return "Choose";
  if (spec.kind === "confirm") return "Confirm";
  return "Question";
}

export function renderPromptCard(spec, onAnswer, onDecline) {
  const card = el(
    "div",
    "border-t border-blue-100 dark:border-blue-900/40 bg-blue-50/60 dark:bg-blue-950/20 px-3 py-2.5"
  );
  card.appendChild(
    el(
      "div",
      "text-[11px] font-semibold uppercase tracking-wide text-blue-600 dark:text-blue-400 mb-1",
      titleFor(spec)
    )
  );
  card.appendChild(el("div", "text-slate-700 dark:text-slate-200 mb-1.5", spec.question));
  if (spec.why) {
    card.appendChild(el("div", "text-slate-500 dark:text-slate-400 text-[11px] mb-2", spec.why));
  }

  const controls = el("div", "flex flex-col gap-2");
  card.appendChild(controls);

  const declineRow = el("div", "");
  const declineBtn = el(
    "button",
    "text-[11px] text-slate-400 dark:text-slate-500 hover:text-slate-600 dark:hover:text-slate-300 hover:underline mt-1",
    "Let the agent decide"
  );
  declineBtn.type = "button";
  declineRow.appendChild(declineBtn);

  // Once answered/declined, swap the interactive controls for a read-only
  // "→ answer" line so the transcript stays legible and can't be re-submitted.
  function finalize(displayText) {
    controls.remove();
    declineRow.remove();
    card.appendChild(
      el("div", "text-emerald-700 dark:text-emerald-400 font-medium mt-0.5", `→ ${displayText}`)
    );
  }

  declineBtn.addEventListener("click", () => {
    finalize("(let the agent decide)");
    onDecline();
  });

  if (spec.kind === "confirm") {
    const row = el("div", "flex gap-2");
    const yesBtn = el(
      "button",
      "px-3 py-1 rounded-lg bg-blue-600 text-white text-xs font-medium hover:bg-blue-700",
      "Yes"
    );
    const noBtn = el(
      "button",
      "px-3 py-1 rounded-lg bg-slate-200 dark:bg-slate-700 text-slate-700 dark:text-slate-200 text-xs font-medium hover:bg-slate-300 dark:hover:bg-slate-600",
      "No"
    );
    yesBtn.type = "button";
    noBtn.type = "button";
    yesBtn.addEventListener("click", () => {
      finalize("Yes");
      onAnswer(true);
    });
    noBtn.addEventListener("click", () => {
      finalize("No");
      onAnswer(false);
    });
    row.appendChild(yesBtn);
    row.appendChild(noBtn);
    controls.appendChild(row);
  } else if (spec.kind === "choice") {
    const options = Array.isArray(spec.options) ? spec.options : [];
    const selected = new Set();
    const row = el("div", "flex flex-wrap gap-1.5");
    options.forEach((opt) => {
      const btn = el(
        "button",
        "px-2.5 py-1 rounded-lg border border-blue-300 dark:border-blue-700 text-blue-700 dark:text-blue-300 text-xs hover:bg-blue-100 dark:hover:bg-blue-900/40",
        opt
      );
      btn.type = "button";
      btn.addEventListener("click", () => {
        if (spec.allowMultiple) {
          if (selected.has(opt)) {
            selected.delete(opt);
            btn.classList.remove("bg-blue-600", "text-white", "border-blue-600");
          } else {
            selected.add(opt);
            btn.classList.add("bg-blue-600", "text-white", "border-blue-600");
          }
        } else {
          finalize(opt);
          onAnswer([opt]);
        }
      });
      row.appendChild(btn);
    });
    controls.appendChild(row);

    if (spec.allowMultiple) {
      const submitBtn = el(
        "button",
        "self-start px-3 py-1 rounded-lg bg-blue-600 text-white text-xs font-medium hover:bg-blue-700",
        "Submit"
      );
      submitBtn.type = "button";
      submitBtn.addEventListener("click", () => {
        if (selected.size === 0) return;
        const chosen = [...selected];
        finalize(chosen.join(", "));
        onAnswer(chosen);
      });
      controls.appendChild(submitBtn);
    }
  } else {
    // text
    const row = el("div", "flex gap-2");
    const input = document.createElement("input");
    input.type = "text";
    input.className =
      "flex-1 min-w-0 rounded-lg border border-blue-300 dark:border-blue-700 bg-white dark:bg-slate-900 px-2.5 py-1 text-xs outline-none focus:ring-2 focus:ring-blue-500/40";
    input.placeholder = "Your answer…";
    const sendBtn = el(
      "button",
      "px-3 py-1 rounded-lg bg-blue-600 text-white text-xs font-medium hover:bg-blue-700",
      "Send"
    );
    sendBtn.type = "button";
    function submit() {
      const value = input.value.trim();
      if (!value) return;
      finalize(value);
      onAnswer(value);
    }
    sendBtn.addEventListener("click", submit);
    input.addEventListener("keydown", (event) => {
      if (event.key === "Enter") submit();
    });
    row.appendChild(input);
    row.appendChild(sendBtn);
    controls.appendChild(row);
    setTimeout(() => input.focus(), 0);
  }

  card.appendChild(declineRow);
  return card;
}

function resolvedDisplayText(entry) {
  if (!entry.answered) {
    if (entry.reason === "timeout") return "(timed out — no answer)";
    if (entry.reason === "aborted") return "(stopped before answering)";
    return "(let the agent decide)";
  }
  if (entry.kind === "confirm") return entry.value ? "Yes" : "No";
  if (Array.isArray(entry.value)) return entry.value.join(", ");
  return String(entry.value);
}

/** Chat-store replay (workbench.js) reconstructs a past turn's DOM from
 * saved data, not from a live pending tool call — there's no promise to
 * resolve, so this renders straight to the already-answered state
 * (renderPromptCard's `finalize()` look) instead of interactive controls.
 * `entry` is a workbench.js hitlLog record: { kind, question, why?,
 * answered, value, reason? }. */
export function renderResolvedPromptCard(entry) {
  const card = el(
    "div",
    "border-t border-blue-100 dark:border-blue-900/40 bg-blue-50/60 dark:bg-blue-950/20 px-3 py-2.5"
  );
  card.appendChild(
    el(
      "div",
      "text-[11px] font-semibold uppercase tracking-wide text-blue-600 dark:text-blue-400 mb-1",
      titleFor(entry)
    )
  );
  card.appendChild(el("div", "text-slate-700 dark:text-slate-200 mb-1.5", entry.question));
  if (entry.why) {
    card.appendChild(el("div", "text-slate-500 dark:text-slate-400 text-[11px] mb-2", entry.why));
  }
  card.appendChild(
    el("div", "text-emerald-700 dark:text-emerald-400 font-medium mt-0.5", `→ ${resolvedDisplayText(entry)}`)
  );
  return card;
}
