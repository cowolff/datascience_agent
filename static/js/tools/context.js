// The single `ctx` object handed to every tool handler and used by the
// registry's wrapper (registry.js). Tools never import the masking / plot /
// call-log modules directly — they receive these capabilities here, which
// is what keeps those choke points centralized (plan §3.3/§5) rather than
// re-referenced ad hoc across a growing set of tool files.

import { sanitize } from "./shared/sanitize.js";
import { registerPlots } from "./shared/plot-store.js";
import { recordCall } from "./shared/call-log.js";
import { requestInput } from "./shared/input-provider.js";

export const ctx = { sanitize, registerPlots, recordCall, requestInput };
