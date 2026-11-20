# 0006: Actions with a day: approve ahead, Tidysum watches the date

Date: 2026-11-14
Status: accepted (the owner: "how can we build that into TidySum when there's like actions that need to
be taken ... at a certain date in the future ... to ensure that we don't miss that stuff", then
"you should be able to monitor my principal ... to see whether it actually had an effect with my
next paycheck ... and we should see these scheduled tasks in TidySum").

## Context

On 2026-11-14 the owner's agent raised his 401(k) to 28% for the last 2026 paychecks. Two things
then had to happen later: check the late-November paystub to see payroll applied it (and raise
December's rate if it didn't), and lower the rate again before the first 2027 paycheck so the
match lasts all year. Neither can be done now, and nothing in Tidysum held a date. Agents act only
when asked (decision 0005), so a step due in January would rely on someone remembering.

Yearly steps already have a home: a detector notices them each year (the backdoor Roth, next
year's 401(k) percent). This is about one-off steps tied to a day, and about giving detectors'
actions a day when the fix has one.

## Decision

1. **An action can have two days.** `not_before`: the first day it may be carried out. `due_by`:
   the last day it still does its job. Either or both. They are columns on `proposal`, so a
   scheduled action is an ordinary action: same states, same approval, same audit log. A follow-up
   check is an action too; its steps can say what to do if the check fails ("if the paystub
   doesn't show 28%, set the whole percent that reaches the limit in December"), so one approval
   covers the fix.
2. **Approve ahead; the yes holds.** The owner can approve a scheduled action as soon as it's
   drafted. It then waits under **Scheduled** on the Actions page until `not_before`, and moves to
   In progress that day. It does not ask again on the day: asking twice is the manual work the
   owner wants gone, and the owner can withdraw the approval at any time before. `start_action`
   refuses it before its day, so no agent can run it early.
3. **Who creates them.** Detectors set the days when they know them: `retirement_rate` puts next
   year's percent in a window from the day after this year's last payday to the first payday of
   next year less the payroll cutoff (`inputs.window`). The owner's agent adds one with the MCP tool
   `schedule_action` (a suggestion, like `create_proposal`; the proposer role may now insert a
   proposal's steps and days). The owner adds one with `tidysum action schedule <file>`. A
   scheduled action may name the finding key it is about even before the detector finds it, so
   that when the detector does, the owner's version stands instead of a second draft, and the key's
   detector decides who carries it out (`carriedBy`).
4. **Tidysum watches the date, not an agent.** `tidysum serve` checks the days every hour
   (`checkSchedule`). It notes in the audit log, once each, when an action comes due
   (`proposal.due`), the day before its last day while it isn't done (`proposal.due_soon`), and when
   it is past due (`proposal.overdue`), and tells the owner each time with a notification on their
   computer (macOS by default). The activity feed shows the same lines.
5. **It can start the owner's agent.** Bring your own agent still holds: there is no Tidysum
   agent. But if the owner sets `TIDYSUM_AGENT_COMMAND` (their own agent's command line, such as
   Claude Code with its browser), Tidysum runs it on an approved, due action no agent has started,
   with the action's id. That is the owner's agent, set up by the owner, working an action the
   owner approved, with the same skill, rules and hand-overs for sign-ins and codes. It runs only
   in waking hours (`TIDYSUM_AGENT_HOURS`, default 8 to 21), at most once a day and three times per
   action, and never once an agent has started the action. Without it, the owner is told and asks
   their agent as usual.

6. **A change no sync can see is confirmed by its check** (owner, 2026-11-14: "why has this been
   stuck in progress for so long?"). A 401(k) election shows in no account until a paycheck lands,
   so its action sat as "waiting for a sync". A follow-up check names the action it checks
   (`follow_up_of`, `follows_up` when scheduling); when the agent finishes the check (and fixes
   what it found, as its steps say), the action it checked is confirmed. Until then the action
   says when Tidysum checks it. An agent's finished action is marked done when the Actions page
   loads and on the hourly pass, not only after the next sync, and the agent's closing note (what
   it actually did, say 28% where the draft said 21%) shows on the action.
7. **A card says what happens next, and an action can wait part way** (owner, 2026-11-20: an action
   for a card whose waitlist the owner had already joined still read "ready for your agent", where it
   should have become a scheduled "check up on waitlist status"; and a scheduled "Checking earns
   nothing" whose real job that day was to check the paycheck had landed). Once the owner has approved an action, the problem
   it fixes is settled; what they need to see is the next thing that happens. So an approved
   action about a finding that waits for a day, or is part done, leads its card with its next
   open step (`headline`, its first sentence when that fits a headline), with the finding
   underneath. An action with its own title keeps it: that title already says what to do.
   And the owner's agent can pause a run part way with `pause_action`: the step that waits, the
   day to look again (`until`, at most 92 days ahead and not after `due_by`) and what happens
   then (`next`, "Check for a card invite"). It is an audit event like every other
   report, so it needs no new column or grant. The action goes back under Scheduled with `next` as
   its headline until that day (`starts_on`), then Tidysum notes it due again, tells the owner
   and starts their agent if they set one up; `start_action` resumes the run with its done steps
   kept. A wait of unknown length (a waitlist) is a pause every week or two until it's over.

## Not chosen

- **Re-approval on the day.** Safer in theory, but it turns every scheduled step into two
  decisions, and the owner can already withdraw approval before the day. Detector-drafted actions
  still withdraw themselves if their finding goes away before they're approved.
- **A separate reminders table.** A scheduled action would then need its own approval, audit and
  progress; keeping it a proposal reuses all of that.
- **Scheduling through the agent's host** (a cloud cron that wakes an assistant). It works only
  for one agent product and keeps the date outside Tidysum, where the owner can't see it.
