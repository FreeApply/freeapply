# FreeApply

Free AI job applications that run on your computer. FreeApply finds jobs that fit your settings, applies through the
AI app you already use, tracks every application in a local dashboard and checks Gmail for employer replies. Any role,
any field.

**Website:** https://www.mybotsai.com · **Install:** https://www.mybotsai.com/install/ ·
**Downloads:** https://www.mybotsai.com/appserver/ · **Release notes:** [release-notes/](release-notes/README.md) · **Source:** https://github.com/FreeApply/freeapply

Current version: **1.0.0** ([notes](release-notes/1.0.0.md)). The app and its legal documents share one version
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
Overview, Applications, Replies, Issues and Settings, plus the Terms, Privacy, Disclosures and Recruiter Terms. The
**Issues** tab collects what needs you:
- **Needs info**: questions a form asked that your settings don't answer. Answer once; you can reuse the answer on
  later forms, and the job goes back in the queue.
- **Needs account**: the job and its sign-up link, plus a **FreeApply Autofill** bookmarklet that fills your name,
  email, phone and location on sign-up pages. Passwords stay with your browser or password manager.
- **Blocked**: the reason, with "I applied myself" and "Re-queue".

## Configuration
| What | Where |
|---|---|
| Data folder | `~/.freeapply`, or the `FREEAPPLY_DATA` environment variable |
| Use an existing database in place | `~/.freeapply/config.json`: `{"db": "C:/path/jobs.db"}`, or `FREEAPPLY_DB` |
| Dashboard port | `FREEAPPLY_PORT` (default 7878; the next free port is used if it is taken) |
| Dashboard only | `node agent/src/main.js --dashboard` |
| Flags | `--data <dir>`, `--db <file>`, `--port <n>`, `--skills-dir <dir>` (repeatable; skill files are kept equal to the signed workflow) |

## Tools
`freeapply_status`, `freeapply_open_dashboard`, `freeapply_workflow` (the signed procedure for a task),
`freeapply_get_settings`, `freeapply_update_settings`, `freeapply_check_duplicate`, `freeapply_add_job`,
`freeapply_update_job`, `freeapply_check_text` (truthfulness check), `freeapply_get_answers`,
`freeapply_site_account`, `freeapply_set_outcome`, `freeapply_site_status`, `freeapply_autorun` (unattended runs),
`freeapply_throttle` (pace check before each submit), `freeapply_list_jobs`, `freeapply_get_stats`,
`freeapply_reply_check_plan`, `freeapply_record_reply`, `freeapply_finish_reply_check`, `freeapply_save_resume_text`,
`freeapply_save_resume_profile`, `freeapply_fetch_posting` (fetches and trims postings on your computer to save
tokens), `freeapply_preview_shared_data`, `freeapply_sync_shared_data`.

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

## Contact
MyBotsAI · mybotsai@gmail.com. Use of FreeApply is governed by its
[Terms of Service](https://www.mybotsai.com/legal/terms/).
