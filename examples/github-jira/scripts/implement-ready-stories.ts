/**
 * Implements every Jira story that is ready, one after another, with nobody at the keyboard:
 *
 *   node --env-file-if-exists=.env scripts/implement-ready-stories.ts PROJ
 *
 * (Node 24 runs TypeScript as is.) The engine is set up from heaw.config.ts, .mcp.json, the
 * agents and skills, exactly as `heaw run` would set it up. Log in to Atlassian first with
 * `heaw mcp login atlassian`. The tool names are those of Atlassian's MCP server at the time of
 * writing; `heaw mcp test atlassian` lists the current ones.
 */
import { createProjectEngine } from 'harness-engineered-agentic-workflow';

const project = process.argv[2] ?? 'PROJ';
// The intent is saved with each session, so `heaw sessions` can tell implementation work apart.
const engine = await createProjectEngine({ intent: 'build' });

/** A tool's output, or an error when the call failed or the rules denied it. */
async function call(tool: string, args: object): Promise<string> {
  const { output, status } = await engine.callTool(tool, args);
  if (status !== 'ok') throw new Error(`${tool}: ${status}\n${output}`);
  return output;
}

try {
  // Every Atlassian tool needs the site's cloud id.
  const sites = await call('mcp__atlassian__getAccessibleAtlassianResources', {});
  const [site] = JSON.parse(sites) as { id: string; url: string }[];
  if (!site) throw new Error(`No Atlassian site found: ${sites}`);

  const found = await call('mcp__atlassian__searchJiraIssuesUsingJql', {
    cloudId: site.id,
    jql: `project = ${project} AND status = "Ready for Development" ORDER BY rank`,
    fields: ['summary'],
  });
  const keys = [...new Set(found.match(/\b[A-Z][A-Z0-9]+-\d+\b/g) ?? [])];
  console.log(`Ready in ${site.url}: ${keys.join(', ') || 'none'}`);

  // One at a time: the stories share the working folder.
  for (const key of keys) {
    const result = await engine.runAgent(
      'main',
      `Implement ${key} with the implement-story skill.`,
      {
        // What heaw.config.ts asks about; nobody is there to ask, so anything else is denied.
        allow: [
          'run_command(git push -u origin HEAD)',
          'mcp__github__create_pull_request',
          'mcp__atlassian__addCommentToJiraIssue',
        ],
        onEvent: (event) => {
          if (event.type === 'tool.end' && !event.parentAgentId) {
            console.log(`  [${key}] ${event.tool}: ${event.status}`);
          }
        },
      },
    );
    const cost = result.costUsd === undefined ? '' : `, $${result.costUsd.toFixed(2)}`;
    console.log(`${key}: ${result.stopReason} (${result.turns} turns${cost})\n${result.text}\n`);
    if (result.stopReason !== 'end_turn') break;
  }
} finally {
  await engine.dispose();
}
