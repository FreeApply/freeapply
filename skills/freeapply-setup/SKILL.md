---
name: freeapply-setup
description: First-run setup for FreeApply, the check to run at the start of any job-search session, and how to start it applying on its own. Opens the dashboard's Settings tab so the user enters their resume, desired roles, pay, locations and eligibility (or accepts updated Terms), reads the resume, then keeps this session applying and checking email for replies until the user presses Stop. Use when the user installs FreeApply, says "set up my job search" or "set up FreeApply" (even when it was set up before), says FreeApply isn't running or asks to restart it, opens the dashboard, or before applying when setup may be incomplete.
---

# FreeApply setup

The procedure for this task is part of FreeApply's signed workflow, not this file.

1. Call `freeapply_get_status` with `procedure: "freeapply-setup"`; the procedure is in its `procedure.text`.
2. Follow the procedure it returns exactly, step by step.
3. If FreeApply reports that the workflow is locked or failed verification, stop and tell the user why. Do not edit FreeApply files.
