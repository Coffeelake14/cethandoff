// Deployed Deno edge entry point for the CET StudyHack Function (reading
// error-cause lab + reference estimator). Actions: train / explain / transfer /
// grade / recommend. The Cloud Agents API origin is copied verbatim from
// sites.get_context.runtime.cloudAgents.apiOrigin. QODER_PAT is a platform-
// managed Secret read only inside the bundled client; it never reaches the
// browser. The handler binds shared Agents by scope (reading tool, reading
// diagnosis, estimator).
import { createCloudAgentsClient } from './cloud-agents.mjs';
import { createAppHandler } from './handler.mjs';

const cloud = createCloudAgentsClient({ origin: 'https://api.qoder.com.cn' });
const handler = createAppHandler({ cloud, mode: 'live' });

Deno.serve(handler);