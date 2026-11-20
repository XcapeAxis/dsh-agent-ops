# DSH Session Finder

**DSH Session Finder 用来按工作区找回以前的会话。** 对话关掉后，只要 DSH 还留着本地记录，就能查到它的标题和归属。

比如上次在 `Template QA` 里做过一次导出检查。这次查到的会话叫 **Verify template export**。

![DSH 实测：now 在 Template QA 找到 Verify template export，session_info 用同一会话 ID 核对标题和连接状态。](docs/now-evidence.png)

*DSH SDK 实测节录。会话为合成数据，图中 ID 只显示后缀。*

## 试用

已在 Windows、Node.js 24.14.0、DeepSeek Harness 0.2.2-rc.1 的 SDK profile 实测。先[下载 v0.1.0 安装包](https://github.com/XcapeAxis/dsh-agent-ops/releases/download/v0.1.0/dsh-agent-ops-0.1.0.tgz)，再在下载目录打开 PowerShell：

```powershell
$env:DSH_HOME = Join-Path $PWD 'agent-ops-demo-home'
dsh plugin --profile sdk add ./dsh-agent-ops-0.1.0.tgz
```

`DSH_HOME` 给试用单独留一份数据。用 SDK 客户端连到这个环境，在工作区建几条测试会话，再让 Agent 按工作区找一条来核对。刚建好的环境没有既有会话，列表为空。

用完后，在同一个 PowerShell 里卸载：

```powershell
dsh plugin --profile sdk remove dsh-agent-ops
```

## 四个查询工具

- `workspace_list` 列出已登记的工作区和会话数量。
- `session_list` 按工作区看会话，默认略过归档和子代理会话。
- `now` 找近期会话，可按工作区缩小范围。默认略过归档、子代理，以及能确认没有内容的冷会话。
- `session_info` 核对某一条会话的标题、归属和连接状态。

没命名的会话如果已有输入，仍可能出现在 `now` 里。查询结果可能带本机路径和首条用户消息的片段，适合在自己的可信 profile 使用。

## 验证过什么

从发布包安装，在两个合成工作区里找回一条未连接的会话，查询前后数据文件一致。卸载并重启后，四个工具都已移除。这轮通过 DSH 宿主直接调用工具。桌面端、其他 DSH 版本和模型自动调用未列入验证范围。

[实测回执](docs/host-verification.json) · [MIT 许可证](LICENSE)
