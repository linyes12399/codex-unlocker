# 打包给别人用的发行 zip：只含启动器、共享核心、bat 和说明，不含任何本机配置/日志
import os, sys, time, zipfile, subprocess

HERE = os.path.dirname(os.path.abspath(__file__))
TOP = 'Codex解锁启动器'
OUT = os.path.join(HERE, 'dist', TOP + '.zip')
# 相对路径（zip 里保持同样的目录结构）；lib/ 是 Windows 与 macOS 共用的核心，必须一起发出去
FILES = ['codex-launcher.js', 'lib/launcher-core.js', '启动Codex解锁版.bat', '使用说明.txt']


def payload(name):
    with open(os.path.join(HERE, name), 'rb') as f:
        data = f.read()
    if name.endswith('.txt'):
        # 记事本/旧系统按 BOM 识别 UTF-8，换行统一 CRLF
        text = data.decode('utf-8-sig').replace('\r\n', '\n').replace('\n', '\r\n')
        data = b'\xef\xbb\xbf' + text.encode('utf-8')
    if name.endswith('.bat'):
        data.decode('ascii')  # cmd 会把多字节字符拆坏，bat 必须是纯 ASCII
        if b'\n' in data.replace(b'\r\n', b''):
            sys.exit('bat 必须是 CRLF 换行')
    return data


def main():
    subprocess.run(['node', '--check', os.path.join(HERE, 'codex-launcher.js')], check=True)
    subprocess.run(['node', '--check', os.path.join(HERE, 'lib', 'launcher-core.js')], check=True)
    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    tmp = OUT + '.tmp'
    now = time.localtime()[:6]
    with zipfile.ZipFile(tmp, 'w', zipfile.ZIP_DEFLATED, compresslevel=9) as z:
        d = zipfile.ZipInfo(TOP + '/', now)
        d.external_attr = 0x10
        z.writestr(d, b'')
        for name in FILES:
            info = zipfile.ZipInfo(TOP + '/' + name, now)
            info.compress_type = zipfile.ZIP_DEFLATED
            z.writestr(info, payload(name))
    os.replace(tmp, OUT)
    print(OUT, os.path.getsize(OUT), 'bytes')


if __name__ == '__main__':
    main()
