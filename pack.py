# 打包给别人用的发行 zip：只含启动器、共享核心、bat 和说明，不含任何本机配置/日志
import os, sys, time, zipfile, subprocess, shutil

HERE = os.path.dirname(os.path.abspath(__file__))
TOP = 'Codex解锁启动器'
OUT = os.path.join(HERE, 'dist', TOP + '.zip')
# 相对路径（zip 里保持同样的目录结构）；lib/ 是 Windows 与 macOS 共用的核心，必须一起发出去
FILES = ['codex-launcher.js', 'lib/launcher-core.js', '启动Codex解锁版.bat', '诊断报告.bat',
         'lib/find-node.cmd', '使用说明.txt']
# 发行包解出来放在 dist 下的那份副本：Windows 的"全部解压"默认解到与 zip 同名的文件夹，
# 于是结构是 dist\Codex解锁启动器\Codex解锁启动器\<文件>。桌面/开始菜单的"Codex 解锁版"
# 快捷方式可能正指着这份副本（用户先解压到 dist 下再建的图标），所以每次打包都必须把它按新
# zip 重建——否则用户点图标跑的还是旧代码：老版本会把 patchSetVersion 判成"需要重建"，
# 反复把镜像覆盖回旧补丁集（401/Ultrafast 问题复现，每轮多拷约 2 GB）。
EXTRACT_ROOT = os.path.join(HERE, 'dist', TOP)


def payload(name):
    with open(os.path.join(HERE, name), 'rb') as f:
        data = f.read()
    if name.endswith('.txt'):
        # 记事本/旧系统按 BOM 识别 UTF-8，换行统一 CRLF
        text = data.decode('utf-8-sig').replace('\r\n', '\n').replace('\n', '\r\n')
        data = b'\xef\xbb\xbf' + text.encode('utf-8')
    if name.endswith(('.bat', '.cmd')):
        data.decode('ascii')  # cmd 会把多字节字符拆坏，.bat/.cmd 必须是纯 ASCII
        if b'\n' in data.replace(b'\r\n', b''):
            sys.exit('.bat/.cmd 必须是 CRLF 换行: ' + name)
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

    # dist\<TOP>\ 下那份"解压出来的副本"按刚打好的 zip 重建（先整个删掉，保证不留多余文件）。
    # 它存在的意义只是让已经指向它的快捷方式能跑到当前代码；不重建就等于把旧代码留在原地。
    # 护栏：EXTRACT_ROOT 是"删整棵树"的目标，必须与 zip 输出文件互不包含，
    # 免得将来有人改动常量把它指向 dist 或工作区根（那会连源码一起删掉）。
    assert os.path.basename(EXTRACT_ROOT) == TOP
    assert OUT != EXTRACT_ROOT and not OUT.startswith(EXTRACT_ROOT + os.sep)
    assert not EXTRACT_ROOT.startswith(HERE + os.sep + '..')
    shutil.rmtree(EXTRACT_ROOT, ignore_errors=True)
    if os.path.exists(EXTRACT_ROOT):
        # rmtree(ignore_errors) 在文件被占用时会静默半删；那份半旧的副本正是要消灭的东西，
        # 所以宁可让打包失败，也不要打出一份"看起来成功了"的旧代码副本。
        sys.exit('无法清空解压副本目录（文件被占用？先关掉资源管理器/编辑器再打包）: ' + EXTRACT_ROOT)
    with zipfile.ZipFile(OUT) as z:
        z.extractall(EXTRACT_ROOT)
    print(EXTRACT_ROOT, '(解压副本已按新 zip 刷新)')


if __name__ == '__main__':
    main()
