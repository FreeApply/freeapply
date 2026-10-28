---
name: freeapply-setup
description: First-run setup for FreeApply, and the check to run at the start of any job-search session. Opens the dashboard's Settings tab so the user enters their resume, desired roles, pay, locations and eligibility, then reads the resume and schedules the Gmail reply check. Use when the user installs FreeApply, says "set up my job search", opens the dashboard, or before applying when setup may be incomplete.
---

# FreeApply setup

The procedure for this task is part of FreeApply's signed workflow, not this file.

1. Call `freeapply_status` with `procedure: "freeapply-setup"`; the procedure is in its `procedure.text`.
2. Follow the procedure it returns exactly, step by step.
3. If FreeApply reports that the workflow is locked or failed verification, stop and tell the user why. Do not edit FreeApply files.
