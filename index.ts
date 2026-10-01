import { fileURLToPath } from 'node:url';
import type { ExtensionAPI, ExtensionCommandContext } from '@oh-my-pi/pi-coding-agent';
import { doctor } from './src/doctor.mjs';
import { listSessions } from './src/sessions.mjs';

const paths = Object.freeze({
  loop: fileURLToPath(new URL('./src/jev-loop.mjs', import.meta.url)),
  driver: fileURLToPath(new URL('./src/cua-driver.mjs', import.meta.url)),
  native: fileURLToPath(new URL('./src/native-target.mjs', import.meta.url)),
  pixels: fileURLToPath(new URL('./src/pixels.mjs', import.meta.url)),
  sessions: fileURLToPath(new URL('./src/sessions.mjs', import.meta.url)),
  demo: fileURLToPath(new URL('./src/demo.mjs', import.meta.url)),
  canvasDemo: fileURLToPath(new URL('./src/canvas-demo.mjs', import.meta.url)),
  visual: fileURLToPath(new URL('./src/visual.mjs', import.meta.url)),
  ocrEval: fileURLToPath(new URL('./src/evals/ocr-canvas.mjs', import.meta.url)),
  judgeEval: fileURLToPath(new URL('./src/evals/judge-choice.mjs', import.meta.url)),
  probe: fileURLToPath(new URL('./src/probe.mjs', import.meta.url)),
  skill: fileURLToPath(new URL('./skills/omp-cua-jev/SKILL.md', import.meta.url)),
});

export default function jev(pi: ExtensionAPI) {
  const { Type } = pi.typebox;
  const host = () => {
    const parameters = pi.getAllTools().find(tool => tool.name === 'eval')?.parameters;
    const schema = parameters && typeof parameters.toJsonSchema === 'function'
      ? parameters.toJsonSchema()
      : parameters;
    const language = schema?.properties?.language;
    const alternatives = language?.anyOf ?? language?.oneOf ?? [language];
    const languages = alternatives.flatMap((item: { enum?: string[]; const?: string } | undefined) =>
      item?.enum ?? (item?.const ? [item.const] : []));
    return {
      version: 'VERSION' in pi.pi ? String(pi.pi.VERSION) : null,
      evalActive: pi.getActiveTools().includes('eval'),
      evalLanguages: languages,
      nativeJs: languages.includes('js'),
    };
  };
  const resources = () => ({ paths, host: host(), minimumOmp: '18.2.7' });
  const report = (details: unknown, ctx: ExtensionCommandContext) => {
    if (ctx.mode === 'print' || ctx.mode === 'json') {
      console.log(ctx.mode === 'json'
        ? JSON.stringify({ type: 'jev', details })
        : JSON.stringify(details, null, 2));
      return;
    }
    pi.sendMessage({
      customType: 'jev', content: JSON.stringify(details, null, 2), display: true, details,
    }, { triggerTurn: false });
  };

  pi.registerTool({
    name: 'jev_resources',
    label: 'Jev resources',
    description: 'Read installed omp-cua-jev helper paths or run read-only prerequisite diagnostics. Never starts sessions, grants permissions, changes settings, or calls a model.',
    approval: 'read',
    parameters: Type.Object({ action: Type.Union([Type.Literal('paths'), Type.Literal('doctor')]) }),
    async execute(_id, params) {
      const details = params.action === 'doctor' ? await doctor({ host: host(), paths }) : resources();
      return { content: [{ type: 'text', text: JSON.stringify(details) }], details };
    },
  });

  pi.registerCommand('jev', {
    description: 'Jev prerequisites, helper paths, read-only sessions, judge probe, isolated localhost demos, or synthetic judge evaluation',
    async handler(args, ctx) {
      const action = args.trim();
      if (action === 'doctor') {
        report(await doctor({ host: host(), paths }), ctx);
        return;
      }
      if (action === 'paths') {
        report(resources(), ctx);
        return;
      }
      if (action === 'sessions') {
        let details;
        try {
          details = { status: 'listed', readOnly: true, sessions: await listSessions(),
            next: `Journaled sessions only. To end orphaned ones, import recoverSessions from ${JSON.stringify(paths.sessions)} in eval and run it with dryRun: true first.` };
        } catch (error) {
          details = { status: 'failed', readOnly: true,
            code: (error as { code?: unknown } | null)?.code === 'SESSIONS_ERROR' ? 'SESSIONS_ERROR' : 'SESSIONS_FAILED' };
        }
        report(details, ctx);
        return;
      }
      if (action !== 'demo' && action !== 'canvas' && action !== 'canvas visual' && action !== 'probe' && action !== 'eval') {
        report({ commands: ['/jev doctor', '/jev paths', '/jev sessions', '/jev probe', '/jev demo', '/jev canvas', '/jev canvas visual', '/jev eval'],
          help: 'Sessions lists local session journals read-only without eval. Probe makes one synthetic call through the existing OMP judge. Demo and canvas use bundled isolated synthetic localhost fixtures and owned-resource cleanup; canvas briefly foregrounds its own isolated browser window for one pixel click. Canvas visual adds live visual/judge selection to that fixture; eval requests a live judge-choice evaluation on bundled synthetic data. Neither visual nor eval is deterministic or completed by command acceptance. None changes approval settings.' }, ctx);
        return;
      }
      const runtime = host();
      if (!runtime.evalActive || !runtime.nativeJs) {
        report({ status: 'blocked', reason: 'This session does not advertise active stock JavaScript eval.',
          next: 'Enable stock eval.js and its eval tool, or import the helpers with your deliberately configured eval language. Do not replace another eval extension automatically.', ...resources() }, ctx);
        return;
      }
      const module = action === 'demo' ? paths.demo
        : action === 'canvas' || action === 'canvas visual' ? paths.canvasDemo
          : action === 'eval' ? paths.judgeEval : paths.probe;
      const invocation = action === 'demo' ? 'runDemo({ judge, onProgress: display })'
        : action === 'canvas' ? 'runCanvasDemo({ judge, onProgress: display })'
          : action === 'canvas visual' ? 'runCanvasDemo({ judge, onProgress: display, visual: true })'
            : action === 'eval' ? 'runJudgeChoiceEval({ judge, onProgress: display })' : 'probeJudge(judge)';
      // Eval is a separate host runtime; the installed module path is selected at command time.
      const code = `display(await (await import(${JSON.stringify(module)})).${invocation});`;
      if (ctx.mode === 'print' || ctx.mode === 'json') {
        report({ status: 'not_started', reason: 'Use this as an initial eval instruction in print mode, or run the command interactively.', language: 'js', code }, ctx);
        return;
      }
      // Canvas visual adds 45 s-bounded perception parses (a warm-up plus one per seat observation) before cleanup.
      const timeout = action === 'probe' ? '' : ` and a timeout of at least ${action === 'canvas visual' ? 300 : 180} seconds so the run and any cleanup are not interrupted`;
      pi.sendUserMessage(`Run this omp-cua-jev ${action} using the existing eval tool with language js${timeout}. Read ${JSON.stringify(paths.skill)} first. Execute only the exact code below, without changing confidence gates, approvals, browser profiles, or targets. Report its actual result, including abstention or incomplete cleanup. Do not call a subprocess model or create credentials. This command authorizes only the bundled synthetic probe, isolated localhost demo (including canvas visual), or synthetic judge-choice evaluation. Visual and eval use the live judge and may abstain; this instruction does not mean either has completed.\n\n${code}`);
    },
  });
}
