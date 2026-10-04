# 打包 macOS 发行 zip：只含启动器、共享核心、两个 .command 入口和说明
# 要点：
#   1) .command 必须是 LF 换行 + 0755 可执行位；zip 里用 external_attr 记录 Unix 权限，
#      macOS 的归档工具解压时会还原。
#   2) 文本按 UTF-8 无 BOM 写（macOS 不需要 Windows 那套 CRLF/BOM）。
import os, sys, zipfile, subprocess

HERE = os.path.dirname(os.path.abspath(__file__))
TOP = 'Codex解锁启动器-macOS'
OUT = os.path.join(HERE, 'dist', TOP + '.zip')

# (仓库内路径, zip 内路径, Unix 权限)
FILES = [
    ('codex-launcher-mac.js', 'codex-launcher-mac.js', 0o644),
    ('lib/launcher-core.js', 'lib/launcher-core.js', 0o644),
    ('启动Codex解锁版.command', '启动Codex解锁版.command', 0o755),
    ('诊断报告.command', '诊断报告.command', 0o755),
    ('使用说明-macOS.txt', '使用说明-macOS.txt', 0o644),
]


def payload(name, data):
    # 统一成 LF；macOS 上没有 CRLF 需求
    if name.endswith(('.command', '.js', '.txt', '.md')):
        data = data.replace(b'\r\n', b'\n')
    if name.endswith('.command'):
        # 第一行必须是 #!，且不能有 BOM，否则内核不会当成脚本执行
        if not data.startswith(b'#!'):
            sys.exit('command 脚本必须以 #! 开头: ' + name)
        if data.startswith(b'\xef\xbb\xbf'):
            sys.exit('command 脚本不能带 BOM: ' + name)
    return data


def main():
    for js in ('codex-launcher-mac.js', 'lib/launcher-core.js'):
        subprocess.run(['node', '--check', os.path.join(HERE, js)], check=True)

    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    tmp = OUT + '.tmp'
    now = (2026, 1, 1, 0, 0, 0)
    with zipfile.ZipFile(tmp, 'w', zipfile.ZIP_DEFLATED, compresslevel=9) as z:
        d = zipfile.ZipInfo(TOP + '/', now)
        d.external_attr = (0o40755 << 16) | 0x10
        z.writestr(d, b'')
        for src, dst, mode in FILES:
            p = os.path.join(HERE, src)
            with open(p, 'rb') as f:
                data = payload(dst, f.read())
            info = zipfile.ZipInfo(TOP + '/' + dst, now)
            info.compress_type = zipfile.ZIP_DEFLATED
            # 高 16 位放 Unix 权限；低 16 位 0 表示普通文件
            info.external_attr = mode << 16
            z.writestr(info, data)
    os.replace(tmp, OUT)
    print(OUT, os.path.getsize(OUT), 'bytes')


if __name__ == '__main__':
    main()
