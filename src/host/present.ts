import type { ViewerError } from '../shared/messages';
import type { HelperErrorPayload } from '../shared/protocol';

const HINTS: Record<HelperErrorPayload['code'], string> = {
  LOCKED: 'DuckDB 允许只读连接共存，但写入进程必须独占数据库。等待占用结束后可继续浏览。',
  VERSION_TOO_NEW: '该数据库由更新版本的 DuckDB 写入，请升级 DuckDB Viewer 后重试。查看器不会尝试改写文件。',
  CORRUPT: '文件不是有效的 DuckDB 数据库，或已损坏。查看器不会修改它。',
  NOT_FOUND: '文件不存在或当前用户无权访问。',
  TIMEOUT: '为避免长时间占用数据库，操作已被放弃，句柄已释放。可以重试，或先缩小筛选范围。',
  CANCELLED: '操作已取消。',
  SQL_ERROR: '可以复制错误信息，用 DuckDB CLI 复核同一查询。',
  INTERNAL: '这是查看器内部错误；重试通常可以恢复。',
};

export function presentError(payload: HelperErrorPayload): ViewerError {
  const hint = HINTS[payload.code];
  switch (payload.code) {
    case 'LOCKED': {
      const owner = payload.processName
        ? `${payload.processName}${payload.pid !== undefined ? ` (PID ${payload.pid})` : ''}`
        : payload.pid !== undefined
          ? `PID ${payload.pid}`
          : '另一个进程';
      return {
        code: payload.code,
        message: `数据库正被 ${owner} 以读写方式占用，无法打开。`,
        hint,
        canRetry: true,
      };
    }
    case 'VERSION_TOO_NEW':
      return { code: payload.code, message: '数据库版本高于当前查看器支持的版本。', hint, canRetry: false };
    case 'CORRUPT':
      return { code: payload.code, message: '无法将文件解析为 DuckDB 数据库。', hint, canRetry: true };
    case 'NOT_FOUND':
      return { code: payload.code, message: '数据库文件不存在或无法访问。', hint, canRetry: true };
    case 'TIMEOUT':
      return { code: payload.code, message: '操作超时。', hint, canRetry: true };
    case 'CANCELLED':
      return { code: payload.code, message: '操作已取消。', hint, canRetry: true };
    case 'SQL_ERROR':
      return { code: payload.code, message: payload.message, hint, canRetry: true };
    default:
      return { code: payload.code, message: payload.message, hint, canRetry: true };
  }
}
