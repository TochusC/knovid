import { AppError, requiredText, uuid } from './errors.mjs';

/** Ownership for project documents/media that remain in the video backend. */
export class ProjectAccessService {
  constructor(db) { this.db = db; }

  async bind({ projectId, userId, requireActive = true }) {
    projectId = requiredText(projectId, 'projectId');
    uuid(userId);
    return this.db.transaction(async (tx) => {
      const { rows: [user] } = await tx.query('SELECT status FROM knovid_users WHERE id=$1 FOR UPDATE', [userId]);
      if (!user) throw new AppError('NOT_FOUND', '账号不存在。', 404);
      if (requireActive && user.status !== 'active') throw new AppError('ACCOUNT_DISABLED', '账号已停用。', 403);
      await tx.query(`INSERT INTO knovid_project_owners(project_id,user_id) VALUES($1,$2)
        ON CONFLICT (project_id) DO NOTHING`, [projectId, userId]);
      const { rows: [owner] } = await tx.query('SELECT user_id FROM knovid_project_owners WHERE project_id=$1', [projectId]);
      if (owner.user_id !== userId) throw new AppError('NOT_FOUND', '项目不存在。', 404);
      return { projectId, userId };
    });
  }

  async requireOwner({ projectId, userId }) {
    projectId = requiredText(projectId, 'projectId');
    uuid(userId);
    const { rows } = await this.db.query(`SELECT p.project_id FROM knovid_project_owners p
      JOIN knovid_users u ON u.id=p.user_id
      WHERE p.project_id=$1 AND p.user_id=$2 AND u.status='active'`, [projectId, userId]);
    if (!rows.length) throw new AppError('NOT_FOUND', '项目不存在。', 404);
    return { projectId, userId };
  }

  async listProjectIds(userId) {
    uuid(userId);
    const { rows } = await this.db.query(`SELECT p.project_id FROM knovid_project_owners p
      JOIN knovid_users u ON u.id=p.user_id WHERE p.user_id=$1 AND u.status='active'
      ORDER BY p.created_at DESC,p.project_id`, [userId]);
    return rows.map((row) => row.project_id);
  }
}
