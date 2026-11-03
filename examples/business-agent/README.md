# Customer support agent

Answers a shop's customers through one HTTP API, following written policies. No shell, files or web.

| File | |
|---|---|
| [`heaw.config.ts`](heaw.config.ts) | Toolsets `http`, `skills`, `todo`; the API and its token; GET free, POST asked; refunds over €100 blocked by a hook |
| [`AGENTS.md`](AGENTS.md) | Who the agent is and how it talks |
| [`.heaw/skills/`](.heaw/skills/) | Refund and delivery policies, loaded when needed |
| [`mock-api.ts`](mock-api.ts) | A stand-in shop API |

```sh
cp .env.example .env                 # add your model's credentials
node --env-file=.env mock-api.ts     # terminal 1
heaw                                 # terminal 2, in this folder
```

Talk to it as `ana@example.com`: *"My headphones broke, can I get my money back?"* (refund, asked to approve) · *"Where are my speakers?"* (delayed order) · *"Cancel them and refund me"* (€240: the hook hands it to a person).

Takeaways: the token never reaches the model; the refund limit is code, not a prompt a customer could argue with; left-out toolsets remove those tools entirely.
