/**
 * Cloudflare Worker for Proposals Database API
 * Handles CORS, proposal CRUD, relationship management, and batch imports via Cloudflare D1.
 */

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const path = url.pathname;
    const method = request.method;

    // 1. Handle CORS Preflight Requests
    if (method === 'OPTIONS') {
      return new Response(null, {
        headers: {
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
          'Access-Control-Allow-Headers': 'Content-Type, Authorization',
          'Access-Control-Max-Age': '86400',
        },
      });
    }

    // Helper to generate CORS responses
    const corsHeaders = {
      'Access-Control-Allow-Origin': '*',
      'Content-Type': 'application/json;charset=utf-8',
    };

    const makeJSONResponse = (data, status = 200) => {
      return new Response(JSON.stringify(data), {
        status,
        headers: corsHeaders,
      });
    };

    // 2. Validate Authorization Passcode for write operations
    const checkAuth = (req) => {
      const authHeader = req.headers.get('Authorization');
      const expectedPasscode = env.ADMIN_PASSCODE || 'admin123'; // Default fallback passcode if env variable not set
      
      if (!authHeader || !authHeader.startsWith('Bearer ')) {
        return false;
      }
      const token = authHeader.substring(7).trim();
      return token === expectedPasscode;
    };

    // Helper to back up an existing proposal into proposals_history table before modifications or deletes
    const backupExistingProposal = async (db, proposalId) => {
      await db.prepare(`
        CREATE TABLE IF NOT EXISTS proposals_history (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          proposal_id TEXT NOT NULL,
          title TEXT NOT NULL,
          status TEXT NOT NULL,
          author TEXT NOT NULL,
          date TEXT NOT NULL,
          content TEXT,
          result TEXT,
          notes TEXT,
          reactions TEXT,
          url TEXT,
          backup_time DATETIME DEFAULT CURRENT_TIMESTAMP
        )
      `).run();

      try {
        await db.prepare('ALTER TABLE proposals_history ADD COLUMN url TEXT').run();
      } catch (e) {}

      try {
        await db.prepare('ALTER TABLE proposals ADD COLUMN url TEXT').run();
      } catch (e) {}

      const existing = await db.prepare('SELECT * FROM proposals WHERE id = ?').bind(proposalId).first();
      if (existing) {
        await db.prepare(`
          INSERT INTO proposals_history (proposal_id, title, status, author, date, content, result, notes, reactions, url)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).bind(
          existing.id,
          existing.title,
          existing.status,
          existing.author,
          existing.date,
          existing.content || '',
          existing.result || '',
          existing.notes || '',
          existing.reactions || '[]',
          existing.url || ''
        ).run();
      }
    };

    try {
      // ==========================================
      // ROUTE: GET / (Status Check)
      // ==========================================
      if (path === '/' && method === 'GET') {
        return makeJSONResponse({
          status: 'ok',
          message: '类脑ΟΔΥΣΣΕΙΑ 提案 API 服务已成功启动运行！',
          database: env.DB ? 'connected' : 'disconnected',
          endpoints: {
            proposals: '/api/proposals',
            relations: '/api/relations'
          }
        });
      }

      // D1 DB Binding verification for all database API endpoints
      if (!env.DB) {
        return makeJSONResponse({ error: 'Database binding (DB) is missing. Please check D1 settings in Cloudflare Dashboard.' }, 500);
      }

      // ==========================================
      // ROUTE: GET /api/proposals (Read Proposals)
      // ==========================================
      if (path === '/api/proposals' && method === 'GET') {
        const { results } = await env.DB.prepare('SELECT * FROM proposals').all();
        
        // Parse reactions JSON string back to JS arrays
        const formattedResults = results.map(row => {
          let reactionsParsed = [];
          if (row.reactions) {
            try {
              reactionsParsed = JSON.parse(row.reactions);
            } catch (e) {
              console.log('Failed to parse reactions JSON for proposal', row.id);
            }
          }
          return {
            ...row,
            reactions: reactionsParsed
          };
        });

        return makeJSONResponse(formattedResults);
      }

      // ==========================================
      // ROUTE: GET /api/relations (Read Linkages)
      // ==========================================
      if (path === '/api/relations' && method === 'GET') {
        const { results } = await env.DB.prepare('SELECT * FROM relations').all();
        return makeJSONResponse(results);
      }

      // ==========================================
      // ROUTE: POST /api/proposals/submit (Create / Update Proposal)
      // ==========================================
      if (path === '/api/proposals/submit' && method === 'POST') {
        if (!checkAuth(request)) {
          return makeJSONResponse({ error: '管理密码校验错误，拒绝执行写入！' }, 401);
        }

        const data = await request.json();
        const { id, title, status, author, date, content, result, notes, reactions, url } = data;

        if (!id || !title || !status || !author || !date) {
          return makeJSONResponse({ error: '缺少必要字段！(id, title, status, author, date)' }, 400);
        }

        // Auto backup current version if proposal already exists
        await backupExistingProposal(env.DB, id);

        // Reactions should be saved as JSON string
        const reactionsStr = JSON.stringify(reactions || []);

        const sql = `
          INSERT INTO proposals (id, title, status, author, date, content, result, notes, reactions, url)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(id) DO UPDATE SET
            title = excluded.title,
            status = excluded.status,
            author = excluded.author,
            date = excluded.date,
            content = excluded.content,
            result = excluded.result,
            notes = excluded.notes,
            reactions = excluded.reactions,
            url = excluded.url
        `;

        await env.DB.prepare(sql)
          .bind(id, title, status, author, date, content || '', result || '', notes || '', reactionsStr, url || '')
          .run();

        return makeJSONResponse({ success: true, message: `提案 ${id} 保存成功！` });
      }

      // ==========================================
      // ROUTE: POST /api/proposals/delete (Delete Proposal)
      // ==========================================
      if (path === '/api/proposals/delete' && method === 'POST') {
        if (!checkAuth(request)) {
          return makeJSONResponse({ error: '管理密码校验错误，拒绝执行删除！' }, 401);
        }

        const data = await request.json();
        const { id } = data;

        if (!id) {
          return makeJSONResponse({ error: '缺少要删除的提案 ID！' }, 400);
        }

        // Auto backup current version before deleting
        await backupExistingProposal(env.DB, id);

        // Delete the proposal
        await env.DB.prepare('DELETE FROM proposals WHERE id = ?').bind(id).run();
        
        // Cascade delete relationship links
        await env.DB.prepare('DELETE FROM relations WHERE source = ? OR target = ?').bind(id, id).run();

        return makeJSONResponse({ success: true, message: `提案 ${id} 及其所有联动关联已彻底从云端删除！` });
      }

      // ==========================================
      // ROUTE: GET /api/admin/backups (Read Backup History)
      // ==========================================
      if (path === '/api/admin/backups' && method === 'GET') {
        if (!checkAuth(request)) {
          return makeJSONResponse({ error: '管理密码校验错误，拒绝访问！' }, 401);
        }

        await env.DB.prepare(`
          CREATE TABLE IF NOT EXISTS proposals_history (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            proposal_id TEXT NOT NULL,
            title TEXT NOT NULL,
            status TEXT NOT NULL,
            author TEXT NOT NULL,
            date TEXT NOT NULL,
            content TEXT,
            result TEXT,
            notes TEXT,
            reactions TEXT,
            backup_time DATETIME DEFAULT CURRENT_TIMESTAMP
          )
        `).run();

        const { results } = await env.DB.prepare('SELECT id, proposal_id, title, status, author, date, backup_time FROM proposals_history ORDER BY backup_time DESC LIMIT 100').all();
        return makeJSONResponse(results);
      }

      // ==========================================
      // ROUTE: POST /api/admin/backups/restore (Restore Backup version)
      // ==========================================
      if (path === '/api/admin/backups/restore' && method === 'POST') {
        if (!checkAuth(request)) {
          return makeJSONResponse({ error: '管理密码校验错误，拒绝恢复！' }, 401);
        }

        const { history_id } = await request.json();
        if (!history_id) {
          return makeJSONResponse({ error: '缺少备份 ID (history_id)！' }, 400);
        }

        const backup = await env.DB.prepare('SELECT * FROM proposals_history WHERE id = ?').bind(history_id).first();
        if (!backup) {
          return makeJSONResponse({ error: '未找到匹配的历史备份记录！' }, 404);
        }

        await backupExistingProposal(env.DB, backup.proposal_id);

        const sql = `
          INSERT INTO proposals (id, title, status, author, date, content, result, notes, reactions, url)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(id) DO UPDATE SET
            title = excluded.title,
            status = excluded.status,
            author = excluded.author,
            date = excluded.date,
            content = excluded.content,
            result = excluded.result,
            notes = excluded.notes,
            reactions = excluded.reactions,
            url = excluded.url
        `;

        await env.DB.prepare(sql)
          .bind(backup.proposal_id, backup.title, backup.status, backup.author, backup.date, backup.content || '', backup.result || '', backup.notes || '', backup.reactions || '[]', backup.url || '')
          .run();

        return makeJSONResponse({ success: true, message: `提案 ${backup.proposal_id} 已成功回滚至 ${backup.backup_time} 备份版本！` });
      }

      // ==========================================
      // ROUTE: POST /api/relations/update (Bulk Update Linkages)
      // ==========================================
      if (path === '/api/relations/update' && method === 'POST') {
        if (!checkAuth(request)) {
          return makeJSONResponse({ error: '管理密码校验错误，拒绝执行写入！' }, 401);
        }

        const list = await request.json(); // Array of { source, type, target }
        if (!Array.isArray(list)) {
          return makeJSONResponse({ error: '请求体格式必须是数组！' }, 400);
        }

        // We run these atomically in a batch:
        // 1. Clear relations table
        // 2. Insert all elements
        const statements = [
          env.DB.prepare('DELETE FROM relations')
        ];

        list.forEach(rel => {
          if (rel.source && rel.type && rel.target) {
            statements.push(
              env.DB.prepare('INSERT OR REPLACE INTO relations (source, type, target) VALUES (?, ?, ?)')
                .bind(rel.source, rel.type, rel.target)
            );
          }
        });

        await env.DB.batch(statements);

        return makeJSONResponse({ success: true, message: `联动关系成功更新 ${list.length} 条！` });
      }

      // ==========================================
      // ROUTE: POST /api/admin/import (One-time Initial Import)
      // ==========================================
      if (path === '/api/admin/import' && method === 'POST') {
        if (!checkAuth(request)) {
          return makeJSONResponse({ error: '管理密码校验错误，拒绝执行写入！' }, 401);
        }

        const payload = await request.json(); // Expected { proposals: [...], relations: [...] }
        const { proposals = [], relations = [] } = payload;

        const statements = [
          env.DB.prepare('DELETE FROM proposals'),
          env.DB.prepare('DELETE FROM relations')
        ];

        // Batch Insert Proposals
        proposals.forEach(p => {
          const reactionsStr = JSON.stringify(p.reactions || []);
          statements.push(
            env.DB.prepare('INSERT INTO proposals (id, title, status, author, date, content, result, notes, reactions, url) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
              .bind(p.id, p.title, p.status, p.author, p.date, p.content || '', p.result || '', p.notes || '', reactionsStr, p.url || '')
          );
        });

        // Batch Insert Relations
        relations.forEach(r => {
          statements.push(
            env.DB.prepare('INSERT INTO relations (source, type, target) VALUES (?, ?, ?)')
              .bind(r.source, r.type, r.target)
          );
        });

        await env.DB.batch(statements);

        return makeJSONResponse({
          success: true,
          message: `数据初始化导入成功！已导入 ${proposals.length} 个提案，${relations.length} 条联动关系。`
        });
      }

      // 404 Route Catch-All
      return makeJSONResponse({ error: 'API route not found' }, 404);

    } catch (err) {
      return makeJSONResponse({ error: `Internal Server Error: ${err.message}` }, 500);
    }
  }
};
