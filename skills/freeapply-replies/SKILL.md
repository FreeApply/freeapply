---
name: freeapply-replies
description: Check the user's email for employer replies to applications FreeApply tracked, record each one (acknowledgement, reply, assessment, interview, rejection, offer), and star or label them as the user chose in Settings. FreeApply's auto-run session does it every 4 hours by default; also use when the user asks "any replies?".
---

# FreeApply email reply check

The procedure for this task is part of FreeApply's signed workflow, not this file.

1. Call `freeapply_get_status` with `procedure: "freeapply-replies"`; the procedure is in its `procedure.text`.
2. Follow the procedure it returns exactly, step by step.
3. If FreeApply reports that the workflow is locked or failed verification, stop and tell the user why. Do not edit FreeApply files.
