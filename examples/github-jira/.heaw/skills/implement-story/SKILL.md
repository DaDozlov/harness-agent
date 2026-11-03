---
name: implement-story
description: Use when asked to implement a Jira story or issue (a key such as PROJ-123) and open a pull request for it.
---
# Implement a Jira story

1. **Read the story.** Get the issue with the Atlassian tools: summary, description, acceptance
   criteria, linked issues and comments. If the acceptance criteria are missing or contradict
   each other, stop and say what is unclear instead of guessing.
2. **Plan.** Write the steps with `todo_write`, one per acceptance criterion where possible.
   Find the code involved before planning changes (`grep`, `glob`, `read_file`).
3. **Branch** from the main branch as it is checked out:
   `git checkout -b story/<KEY>-<short-slug>`.
4. **Implement** in small steps. Add or update tests for every acceptance criterion. Follow the
   conventions in AGENTS.md.
5. **Verify.** Run the tests and the linter; fix what fails. You cannot finish while they fail.
6. **Commit** with the message `<KEY>: <what changed>`, then push the branch
   (`git push -u origin HEAD`).
7. **Open a pull request** with the GitHub tools: title `<KEY>: <summary>`, and a body with
   what changed, how it was tested, `Implements <KEY>` plus the issue link, and a last line
   `heaw session: <id>` with the session id from your environment, so reviewers can find this
   conversation.
8. **Report back** on the Jira issue with a comment linking the pull request. Do not move the
   issue to Done: review and merge are for people.

Finish with the pull request link and anything left open.
