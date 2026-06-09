-- 0019_workflow_run_attachments: dropped-in inputs for a workflow run
--
-- A run can carry uploaded files/folders/images/PDFs the same way an agent task
-- does. The bytes are staged on disk under ~/.modulus/agent-attachments/staging/
-- <stage_token>/; the runner ingests that batch into each agent-node task as it
-- runs (so the model sees images and read_file/list_dir pin to the files), then
-- removes the batch when the run drains. Only the token is persisted here.

ALTER TABLE workflow_runs ADD COLUMN stage_token TEXT;
