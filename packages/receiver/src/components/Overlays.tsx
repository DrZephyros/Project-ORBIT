import type { ApprovalRequest, TaskState, TranscriptEvent } from '@orbit/shared';

interface Props {
  voiceState: 'idle' | 'listening' | 'transcribing';
  transcript: TranscriptEvent | null;
  task: TaskState | null;
  approval: ApprovalRequest | null;
  onCommand: (text: string) => void;
  onApproval: (approvalId: string, accept: boolean) => void;
  onDismissApproval: () => void;
}

/**
 * Overlays are intentionally dismissible at every stage. The plan requires
 * cancellation to be available throughout, so nothing here is modal-locked.
 */
export function Overlays({ voiceState, transcript, task, approval, onCommand, onApproval, onDismissApproval }: Props) {
  if (approval) {
    return (
      <div className="overlay" role="dialog" aria-modal="true" aria-labelledby="approval-title">
        <div className="sheet">
          <span className="badge accent">Approval needed</span>
          <h3 id="approval-title" style={{ marginTop: 12 }}>
            {approval.action}
          </h3>
          <p>{approval.detail}</p>
          <p className="note" style={{ marginTop: 0 }}>
            Expires {new Date(approval.expiresAt).toLocaleTimeString()}. Nothing runs until you
            accept.
          </p>
          <div className="sheet-actions">
            <button
              className="btn btn-ghost"
              onClick={() => {
                onApproval(approval.id, false);
                onDismissApproval();
              }}
            >
              Decline
            </button>
            <button
              className="btn btn-primary"
              onClick={() => {
                onApproval(approval.id, true);
                onDismissApproval();
              }}
            >
              Accept
            </button>
          </div>
        </div>
      </div>
    );
  }

  if (voiceState !== 'idle') {
    return (
      <div className="overlay" role="dialog" aria-modal="true" aria-label="Voice input">
        <div className="sheet">
          <div className="listening">
            <span className="pulse" />
            <div>
              <h3 style={{ margin: 0 }}>{voiceState === 'listening' ? 'Listening' : 'Transcribing'}</h3>
              <p style={{ margin: 0 }}>
                {voiceState === 'listening' ? 'Speak one instruction, then stop.' : 'Working on what you said.'}
              </p>
            </div>
          </div>
          {transcript ? (
            <div className={`transcript${transcript.provisional ? ' provisional' : ''}`}>{transcript.text}</div>
          ) : null}
          <div className="sheet-actions">
            <button className="btn btn-ghost" onClick={() => onCommand('')}>
              Cancel
            </button>
          </div>
        </div>
      </div>
    );
  }

  if (task) {
    const open = task.status !== 'succeeded' && task.status !== 'cancelled' && task.status !== 'failed';
    if (!open && task.status === 'succeeded') {
      // Successful tasks do not need an overlay; the desktop shows detail.
      return null;
    }
    return (
      <div className="overlay" role="dialog" aria-modal="true" aria-label="Task progress">
        <div className="sheet">
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <span className={`badge ${task.status === 'failed' ? 'danger' : 'accent'}`}>{task.status}</span>
            {open ? <span className="spinner" /> : null}
          </div>
          <h3 style={{ marginTop: 12 }}>{task.utterance || 'Task'}</h3>
          {task.error ? <p style={{ color: 'var(--danger)' }}>{task.error}</p> : null}
          <ul className="task-steps">
            {task.steps.map((step) => (
              <li key={step.index} className={`task-step ${step.status}`}>
                <span className="step-mark">{mark(step.status)}</span>
                <span>
                  {step.label}
                  {step.detail ? <span className="note" style={{ display: 'block', marginTop: 2 }}>{step.detail}</span> : null}
                </span>
              </li>
            ))}
          </ul>
          <div className="sheet-actions">
            {open ? (
              <button className="btn btn-danger" onClick={() => onCommand('stop')}>
                Stop task
              </button>
            ) : (
              <button className="btn btn-ghost" onClick={() => onCommand('__dismiss')}>
                Dismiss
              </button>
            )}
          </div>
        </div>
      </div>
    );
  }

  // Nothing to show: the workspace stays unobstructed.
  return null;
}

function mark(status: 'pending' | 'running' | 'done' | 'skipped' | 'failed'): string {
  switch (status) {
    case 'done':
      return '✓';
    case 'running':
      return '›';
    case 'failed':
      return '✕';
    case 'skipped':
      return '—';
    default:
      return '·';
  }
}
