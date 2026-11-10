import { defineConfig } from 'harness-engineered-agentic-workflow';

/**
 * heaw's own setup: for working on this repository with heaw, and for its eval suite (evals/),
 * whose trials get these rules. There are no hooks and no model here on purpose: the evals
 * measure the harness as it comes, with the model from HEAW_MODEL (.env) or --model.
 */
export default defineConfig({
  models: {
    // The local model of the comparison in evals/README.md: free, and Ollama serves it with a
    // 32k context (OLLAMA_CONTEXT_LENGTH), of which a quarter is kept for the answer.
    'ollama:qwen3-coder:30b': {
      contextWindow: 32_768,
      maxOutputTokens: 8_192,
      pricing: { input: 0, output: 0 },
    },
  },
  permissions: {
    mode: 'accept-edits',
    // The project's own scripts and git commands that only read (`git diff*` would also allow
    // `--output=<file>`, which writes).
    allow: [
      'run_command(npm test*)',
      'run_command(npm run *)',
      'run_command(node --test*)',
      'run_command(git status*)',
      'run_command(git diff)',
      'run_command(git diff -- *)',
    ],
    deny: ['read_file(**/.env)', 'read_file(**/.env.!(example))', 'run_command(rm -rf*)'],
  },
  limits: { maxTurns: 100, maxCostUsd: 5 },
});
