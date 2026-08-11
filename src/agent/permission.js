/**
 * Permission gating for side-effecting tools.
 *
 * A local model with shell access can do real damage by accident, so anything
 * that writes or executes stops here first. Approvals are scoped to the running
 * process: "allow all edit_file" is a statement about this session, not a
 * standing grant that silently persists into future runs.
 */

export const DECISION = {
  ALLOW: 'allow',
  DENY: 'deny',
};

export class PermissionManager {
  /**
   * @param {object} opts
   * @param {(req: object) => Promise<string>} opts.ask Prompts the user; resolves
   *   to 'allow', 'always', or 'deny'.
   * @param {string[]} [opts.autoApprove] Tool names pre-approved by config.
   */
  constructor({ ask, autoApprove = [], approveAll = false } = {}) {
    this.ask = ask;
    this.autoApprove = new Set(autoApprove);
    this.approveAll = approveAll;
    /** Tools the user approved for the rest of this session. */
    this.sessionApproved = new Set();
    /** Set when the user cancels, so the rest of the turn unwinds quietly. */
    this.aborted = false;
  }

  isPreApproved(tool) {
    // approveAll is for runs with nobody at the keyboard — a benchmark, a
    // script, CI. Named for what it does rather than something reassuring,
    // because it removes the only thing standing between the model and an
    // arbitrary shell command.
    return this.approveAll
      || tool.permission !== 'ask'
      || this.autoApprove.has(tool.name)
      || this.sessionApproved.has(tool.name);
  }

  /**
   * @returns {Promise<{decision: string, reason?: string}>}
   */
  async request(tool, args) {
    if (this.isPreApproved(tool)) return { decision: DECISION.ALLOW };
    if (!this.ask) {
      return { decision: DECISION.DENY, reason: 'No approval mechanism is available in this mode.' };
    }

    const answer = await this.ask({ tool, args, summary: summarize(tool.name, args) });

    if (answer === 'always') {
      this.sessionApproved.add(tool.name);
      return { decision: DECISION.ALLOW };
    }
    if (answer === 'allow') return { decision: DECISION.ALLOW };

    this.aborted = true;
    return { decision: DECISION.DENY, reason: 'The user declined this action.' };
  }
}

/** One-line description of what is about to happen, shown in the prompt. */
function summarize(name, args = {}) {
  switch (name) {
    case 'run_command':
      return `run: ${truncate(args.command, 200)}`;
    case 'write_file':
      return `write ${args.path} (${String(args.content ?? '').split('\n').length} lines)`;
    case 'edit_file':
      return `edit ${args.path}${args.replace_all ? ' (all occurrences)' : ''}`;
    default: {
      const rendered = Object.entries(args)
        .map(([k, v]) => `${k}=${truncate(typeof v === 'string' ? v : JSON.stringify(v), 60)}`)
        .join(' ');
      return `${name} ${rendered}`.trim();
    }
  }
}

function truncate(text, max) {
  const s = String(text ?? '');
  return s.length > max ? `${s.slice(0, max)}…` : s;
}

export { summarize };
