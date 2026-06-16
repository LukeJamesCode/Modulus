-- Drop the authored-workflow feature. The DAG engine (workflows.ts /
-- workflow-runner.ts), its panel routes, and the canvas UI were removed; these
-- tables are now orphaned. Agent delegation (spawn_agent) covers the runtime
-- routing use case the workflow engine duplicated.
DROP TABLE IF EXISTS workflow_step_runs;
DROP TABLE IF EXISTS workflow_runs;
DROP TABLE IF EXISTS workflows;
