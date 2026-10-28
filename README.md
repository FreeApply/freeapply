# FreeApply

Free AI job applications that run on your computer. FreeApply finds jobs that fit your settings, applies through the
AI app you already use, tracks every application in a local dashboard and checks Gmail for employer replies. Any role,
any field.

**Website:** https://www.mybotsai.com · **Install:** https://www.mybotsai.com/install/ ·
**Downloads:** https://www.mybotsai.com/appserver/ · **Release notes:** [release-notes/](release-notes/README.md) · **Source:** https://github.com/FreeApply/freeapply

Current version: **1.0.2** ([notes](release-notes/1.0.2.md)). The app and its legal documents share one version
number.

## What it does
- **Finds jobs that fit**: roles, pay floor and locations from your settings, on the job sites you choose. Duplicates
  and reposts it has already tracked are skipped.
- **Applies for you** on employer sites and job boards with your real details, your résumé and answers you saved once,
  at a measured pace.
- **Never invents experience.** Cover letters and answers are checked against your résumé and settings before they
  are used.
- **Knows when to stop.** CAPTCHAs, new accounts, passwords and questions your settings don't answer go to the Issues
  tab for you.
- **Tracks everything** in a dashboard at `http://127.0.0.1:7878`, reachable only from your computer.
- **Watches for replies** with your AI app's Gmail connector, every 4 hours by default.

## Install
| App | How |
|---|---|
| Claude Desktop | Download [`freeapply.mcpb`](https://www.mybotsai.com/appserver/freeapply.mcpb) and double-click it, or drag it into Settings → Extensions. Nothing else to install. |
| Claude Code, Cursor, VS Code, Windsurf | Windows: `irm https://www.mybotsai.com/appserver/install.ps1 \| iex`<br>macOS and Linux: `curl -fsSL https://www.mybotsai.com/appserver/install.sh \| bash`<br>Needs Node.js 22.13 or newer. The installer checks the package's signature, then asks before adding FreeApply to each app it finds. |
| Claude Code, from this repository | `/plugin marketplace add FreeApply/freeapply`, then `/plugin install freeapply@freeapply` |
| Any other MCP app | Unpack `freeapply.mcpb` (it is a ZIP file) and add a stdio server that runs `node /path/to/freeapply/src/main.js`. |

To update, install the new version the same way. To uninstall, see https://www.mybotsai.com/install/#uninstall. Your
data in `~/.freeapply` stays until you delete that folder.

## First run
1. Restart your AI app and say **"Set up FreeApply"**. The dashboard opens.
2. Read and accept the Terms of Service and Privacy Policy there yourself (18+). Until you do, every agent tool except
   `freeapply_status` and `freeapply_open_dashboard` refuses to run, and the agent can never accept for you.
3. Fill in **Settings**: résumé (PDF, DOCX, TXT or MD), name and email, desired roles, minimum pay, locations, work
   authorization and the job sites you use. The agent applies nowhere until these are filled.
4. Sign in to your job sites in the browser your AI app uses, then say **"Find me jobs and apply"**.

With a Gmail connector, setup also schedules the reply check, which stars replies, labels them, or both (your choice
in Settings).

## Guarantees
- Facts about you come only from your résumé, your settings and what you tell the agent. It never invents experience.
- It never types passwords, creates accounts or solves CAPTCHAs. Those jobs are flagged for you.
- **Signed workflow.** The procedures, server instructions and hard limits ship in `agent/workflow.signed.json`,
  signed with our release key. Any edit fails verification and locks the tools until the official copy is restored.
  Pacing, duplicate checks, the pay floor and the truthfulness check are enforced in the tool code, not just asked of
  the AI.
- Your data stays on your computer, except what your data-sharing choices send. The dashboard accepts only local
  requests that carry its own header.

## Data sharing
| Choice | United States | Everywhere else, or with Global Privacy Control |
|---|---|---|
| Anonymous usage statistics | On by default, one-click opt-out | Opt-in |
| Job-market data (no name or contact details; sold only as totals covering 5+ installations) | On by default, one-click opt-out | Opt-in |
| Recruiter Talent Pool (contact details and résumé, sold to recruiters) | Opt-in | Opt-in |
| Product update emails | Opt-in | Opt-in |

The region comes from your profile country, otherwise your computer's language and time zone; unknown counts as
outside the US. In Settings → Data sharing you can preview exactly what is sent, sync now, and delete everything
already shared. Details: [Privacy Policy](https://www.mybotsai.com/legal/privacy/).

The dashboard shows one card labeled "Sponsored", chosen on your computer from a signed pack. No ad scripts, no
trackers, and no data is sent to show it.

## Dashboard
Overview, Applications, Replies, Issues and Settings, with the Terms, Privacy Policy, Disclosures and Recruiter Terms
linked in the footer. The **Needs you** tab collects what needs you, in plain words:
- **Questions**: what a form asked that your settings don't answer, each as a simple question you answer by typing,
  from a dropdown or by picking options. A question several jobs ask is shown once, and one answer goes to all of
  them; questions you already answered aren't asked again. The jobs then go back in the queue.
- **Accounts to create**: one card per sign-up page, however many jobs wait on that account, with its link and a
  **FreeApply Autofill** bookmarklet that fills your name, email, phone and location on sign-up pages. Passwords stay
  with your browser or password manager.
- **Blocked**: what the site asked for (a "prove you're a person" check, a code, a warning), with "I applied myself",
  "Try again later" and "Skip this job".

## Configuration
| What | Where |
|---|---|
| Data folder | `~/.freeapply`, or the `FREEAPPLY_DATA` environment variable |
| Use an existing database in place | `~/.freeapply/config.json`: `{"db": "C:/path/jobs.db"}`, or `FREEAPPLY_DB` |
| Dashboard port | `FREEAPPLY_PORT` (default 7878; the next free port is used if it is taken) |
| Dashboard only | `node agent/src/main.js --dashboard` |
| Flags | `--data <dir>`, `--db <file>`, `--port <n>`, `--skills-dir <dir>` (repeatable; skill files are kept equal to the signed workflow) |

## Tools
18 tools, each with a title, annotations (read-only, destructive, idempotent) and a description of every parameter:
`freeapply_status` (can FreeApply run, plus the signed procedure for a task), `freeapply_open_dashboard`,
`freeapply_get_settings` (all settings or just the sections a step needs), `freeapply_update_settings` (settings, the
résumé text and profile, and the AI models scan that picks a model for each part of the work),
`freeapply_fetch_posting` (fetches and trims postings on your computer to save tokens, with their ATS keywords), `freeapply_claim_job` (claim or
skip a job, with the duplicate, job-site and pay-floor checks), `freeapply_check_text` (truthfulness check; saves a passing cover letter as a PDF),
`freeapply_user_answers` (get a job's answers or save a reusable one), `freeapply_find_site_account`,
`freeapply_clear_to_submit` (clearance before each submit, and the unattended run's budgets), `freeapply_update_job` (your
side: found to applied), `freeapply_report_site_problem`, `freeapply_autorun` (start or finish unattended runs),
`freeapply_list_jobs`, `freeapply_job_stats`, `freeapply_reply_check` (start or finish a Gmail check),
`freeapply_record_outcome` (what an employer did, from an email or the user), `freeapply_shared_data` (preview or send
shared data). Removing a job is a dashboard action only (Applications → Remove); the agent has no tool for it.
Every call is checked against the tool's parameters first: a missing, unknown or wrongly typed parameter returns one
error naming each problem, and nothing changes.

Skills for Claude Code: `freeapply-setup`, `freeapply-apply`, `freeapply-replies`. Each points to its signed procedure.

## Check a download
Every package comes with a `.sig.json` file holding its SHA-256, signed with an Ed25519 key whose private half never
leaves our offline machine. The public keys are in [`agent/keys/`](agent/keys/). Compare the checksum with the one in
[`latest.json`](https://www.mybotsai.com/appserver/latest.json):

```
Get-FileHash .\freeapply.mcpb -Algorithm SHA256      # Windows
shasum -a 256 freeapply.mcpb                         # macOS, Linux
```

The installer and the app's own update check do this and the signature check for you; a download that doesn't match
is refused.

## This repository
| Path | What |
|---|---|
| `agent/` | The app: an MCP server in Node.js with no dependencies, the dashboard (`web/`), the legal texts (`web/legal/`), the signed workflow and the public keys. It is also the Claude Desktop extension (`manifest.json`). |
| `skills/` | Claude Code skills that point to the signed procedures |
| `.claude-plugin/`, `.mcp.json` | Claude Code plugin and marketplace files |
| `release-notes/` | What changed in each version |
| `LICENSE` | MIT License for the source code |

## License
The source code is released under the [MIT License](LICENSE). The FreeApply name and logo are not covered by it; use
of FreeApply and of the services we host is governed by the
[Terms of Service](https://www.mybotsai.com/legal/terms/).

## Contact
MyBotsAI · mybotsai@gmail.com.
