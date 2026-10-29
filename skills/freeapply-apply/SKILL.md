---
name: freeapply-apply
description: Find jobs that match the user's FreeApply settings (any role or field) and apply on the employer's site or job board, logging every job and application to FreeApply. Use when the user says apply, run the job agent, find me jobs, or keep applying.
---

# FreeApply apply

The procedure for this task is part of FreeApply's signed workflow, not this file.

1. Call `freeapply_get_status` with `procedure: "freeapply-apply"`; the procedure is in its `procedure.text`.
2. Follow the procedure it returns exactly, step by step.
3. If FreeApply reports that the workflow is locked or failed verification, stop and tell the user why. Do not edit FreeApply files.
