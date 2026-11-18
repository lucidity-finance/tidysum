-- Bring your own agent (decision 0005): there is no Tidysum agent, so a step the owner's agent
-- carries out says `by: agent`, not `by: tidysum`.
UPDATE proposal SET steps = (
  SELECT jsonb_agg(
    CASE WHEN s->>'by' = 'tidysum' THEN jsonb_set(s, '{by}', '"agent"') ELSE s END
    ORDER BY n)
  FROM jsonb_array_elements(steps) WITH ORDINALITY AS t(s, n)
)
WHERE steps IS NOT NULL AND jsonb_array_length(steps) > 0;
