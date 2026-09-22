import { fileURLToPath } from 'node:url';
import type { ExtensionAPI, ExtensionCommandContext } from '@oh-my-pi/pi-coding-agent';
import { doctor } from './src/doctor.mjs';

const paths = Object.freeze({
  loop: fileURLToPath(new URL('./src/jev-loop.mjs', import.meta.url)),
  driver: fileURLToPath(new URL('./src/cua-driver.mjs', import.meta.url)),
  demo: fileURLToPath(new URL('./src/demo.mjs', import.meta.url)),
  probe: fileURLToPath(new URL('./src/probe.mjs', import.meta.url)),
  skill: fileURLToPath(new URL('./skills/omp-jev/SKILL.md', import.meta.url)),
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
    description: 'Read installed omp-jev helper paths or run read-only prerequisite diagnostics. Never starts sessions, grants permissions, changes settings, or calls a model.',
    approval: 'read',
    parameters: Type.Object({ action: Type.Union([Type.Literal('paths'), Type.Literal('doctor')]) }),
    async execute(_id, params) {
      const details = params.action === 'doctor' ? await doctor({ host: host(), paths }) : resources();
      return { content: [{ type: 'text', text: JSON.stringify(details) }], details };
    },
  });

  pi.registerCommand('jev', {
    description: 'Jev prerequisites, helper paths, judge probe, or isolated native localhost demo',
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
      if (action !== 'demo' && action !== 'probe') {
        report({ commands: ['/jev doctor', '/jev paths', '/jev probe', '/jev demo'],
          help: 'Probe makes one synthetic call through the existing OMP judge. Demo authorizes an isolated Cua browser and a synthetic localhost receipt, followed by owned-resource cleanup. Neither changes approval settings.' }, ctx);
        return;
      }
      const runtime = host();
      if (!runtime.evalActive || !runtime.nativeJs) {
        report({ status: 'blocked', reason: 'This session does not advertise active stock JavaScript eval.',
          next: 'Enable stock eval.js and its eval tool, or import the helpers with your deliberately configured eval language. Do not replace another eval extension automatically.', ...resources() }, ctx);
        return;
      }
      const module = action === 'demo' ? paths.demo : paths.probe;
      const invocation = action === 'demo'
        ? 'runDemo({ judge, onProgress: display })'
        : 'probeJudge(judge)';
      // Eval is a separate host runtime; the installed module path is selected at command time.
      const code = `display(await (await import(${JSON.stringify(module)})).${invocation});`;
      if (ctx.mode === 'print' || ctx.mode === 'json') {
        report({ status: 'not_started', reason: 'Use this as an initial eval instruction in print mode, or run the command interactively.', language: 'js', code }, ctx);
        return;
      }
      pi.sendUserMessage(`Run this omp-jev ${action} using the existing eval tool with language js. Read ${JSON.stringify(paths.skill)} first. Execute only the exact code below, without changing confidence gates, approvals, browser profiles, or targets. Report its actual result, including abstention or incomplete cleanup. Do not call a subprocess model or create credentials. This command authorizes only the bundled synthetic probe or isolated localhost demo.\n\n${code}`);
    },
  });
}
