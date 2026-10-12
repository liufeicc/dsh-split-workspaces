/**
 * Host half of the split-workspaces bundle. The Host row only rides the Loader
 * tree so the module roster picks up this package's `dsh.client` declaration;
 * every behaviour lives in `client.js`.
 *
 * 窗格标题栏上那个「用文件管理器打开工作区目录」的按钮**不需要这一半做什么**：
 * 真正干活的 Host 能力已经随 dsh 装好了 —— `@deepseek-ai/dsh-api-session-controller`
 * 把 `canOpenWorkspacePath`（这个部署能不能把路径交给桌面）与 `openWorkspacePath`
 * （在组合文件系统里校验路径、再按操作系统关联打开它）挂在 `session` 远端命名空间上，
 * 目录的关联就是文件管理器。这里再写一份 —— 无论是自己起 `xdg-open` 还是走
 * open-in-app 的 HTTP 路由 —— 都只是把人家维护好的东西抄一遍，还得让用户重启 Host
 * 才能生效，所以本行保持空壳。
 */
export function apply() {}
