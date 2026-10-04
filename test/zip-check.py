# 校验两个发行 zip：目录结构、Unix 权限位、换行、BOM、内容能否通过 node --check
# 说明：脚本内不写中文字面量（避免不同控制台编码把输出弄乱），按文件名后缀区分两个平台包。
import os, sys, glob, subprocess, zipfile, tempfile, shutil

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
DIST = os.path.join(ROOT, 'dist')
bad = 0


def check(cond, msg):
    global bad
    print(('  OK   ' if cond else '  FAIL ') + msg)
    if not cond:
        bad += 1


def safe(name):
    return name.encode('ascii', 'backslashreplace').decode('ascii')


def norm_text(data):
    # .txt 在 zip 里是 BOM + CRLF，仓库里是 UTF-8 无 BOM + LF：比对前统一
    return data.replace(b'\xef\xbb\xbf', b'').replace(b'\r\n', b'\n')


def check_fresh(zip_path, top, expect_extracted):
    """Zip contents must match the repo sources, and (Windows only) the extracted copy must match the zip.

    Why: "Extract All" next to the zip creates dist/<top>/<top>/, and a desktop/start-menu
    shortcut may point right at it. A stale copy means the user's icon keeps running old code
    (an older launcher rebuilds the mirror back to its own patch set, which brings the
    401 / Ultrafast bugs back on every click). Making both comparisons assertions keeps that
    from shipping silently.

    The mac zip shares lib/launcher-core.js with the windows one, so its contents are checked
    against the sources too (there is no extracted copy for mac, see pack-mac.py).
    """
    print('\n== freshness (zip == sources%s) ==' % (', extracted copy == zip' if expect_extracted else ''))
    z = zipfile.ZipFile(zip_path)
    names_in_zip = [n[len(top) + 1:] for n in z.namelist()
                    if n.startswith(top + '/') and not n.endswith('/')]
    for name in names_in_zip:
        disk = os.path.join(ROOT, name.replace('/', os.sep))
        if not os.path.exists(disk):
            continue  # no source file in the repo (nothing to compare against)
        inside = z.read(top + '/' + name)
        check(norm_text(inside) == norm_text(open(disk, 'rb').read()),
              'zip in sync with repo source: ' + safe(name))

    if not expect_extracted:
        return

    # The extracted copy under dist/ (that is what a "Extract All" next to the zip creates, and a
    # desktop/start-menu shortcut may point right at it). Only the windows zip has one.
    extracted = os.path.join(DIST, top)
    sub = os.path.join(extracted, top)
    if not os.path.isdir(extracted):
        check(False, 'extracted copy exists under dist (%s)' % safe(top))
        return
    check(True, 'extracted copy exists under dist (%s)' % safe(top))
    in_zip = sorted(names_in_zip)
    on_disk = sorted(os.path.relpath(os.path.join(r, f), sub).replace(os.sep, '/')
                     for r, _, fs in os.walk(sub) for f in fs) if os.path.isdir(sub) else []
    check(on_disk == in_zip, 'extracted copy file list matches zip: ' + safe(str(on_disk)))
    for name in on_disk:
        p = os.path.join(sub, name.replace('/', os.sep))
        check(norm_text(open(p, 'rb').read()) == norm_text(z.read(top + '/' + name)),
              'extracted copy in sync with zip (not an old build): ' + safe(name))


def inspect(zip_path, expect_names, expect_suffixes=(), platform='mac'):
    print('\n== %s (%d bytes) ==' % (safe(os.path.basename(zip_path)), os.path.getsize(zip_path)))
    z = zipfile.ZipFile(zip_path)
    names = z.namelist()
    tops = sorted(set(n.split('/')[0] for n in names))
    check(len(tops) == 1, 'single top-level dir: ' + safe(str(tops)))
    top = tops[0]
    for suf in expect_names:
        check(any(n == top + '/' + suf for n in names), 'contains: ' + safe(suf))
    for suf in expect_suffixes:
        check(any(n.endswith(suf) for n in names), 'contains *' + safe(suf))

    for i in z.infolist():
        base = i.filename.split('/')[-1]
        if i.filename.endswith('/'):
            continue
        data = z.read(i.filename)
        if platform == 'mac':
            # macOS：权限位决定 .command 能否双击运行；LF、无 BOM
            mode = (i.external_attr >> 16) & 0o777
            want = 0o755 if i.filename.endswith('.command') else 0o644
            check(mode == want, '%s mode=%s want=%s' % (safe(base), oct(mode), oct(want)))
            check(not data.startswith(b'\xef\xbb\xbf'), 'no BOM: ' + safe(base))
            if i.filename.endswith(('.command', '.js', '.txt')):
                check(b'\r\n' not in data, 'LF newlines: ' + safe(base))
            if i.filename.endswith('.command'):
                check(data.startswith(b'#!'), 'shebang: ' + safe(base))
        else:
            # Windows：bat/cmd 必须纯 ASCII + CRLF；说明文本带 BOM + CRLF 便于记事本识别
            if i.filename.endswith(('.bat', '.cmd')):
                try:
                    data.decode('ascii')
                    check(True, 'ascii-only: ' + safe(base))
                except UnicodeDecodeError:
                    check(False, 'ascii-only: ' + safe(base))
                check(b'\r\n' in data and b'\n' not in data.replace(b'\r\n', b''), 'CRLF newlines: ' + safe(base))
            if i.filename.endswith('.txt'):
                check(data.startswith(b'\xef\xbb\xbf'), 'BOM for notepad: ' + safe(base))
                check(b'\r\n' in data, 'CRLF newlines: ' + safe(base))

    # 解压到工作区内的临时目录做真实语法检查（会话临时目录在受限环境下可能不可写）
    tmp = os.path.join(ROOT, '.tmp-zipcheck')
    shutil.rmtree(tmp, ignore_errors=True)
    try:
        os.makedirs(tmp)
        z.extractall(tmp)
        root = os.path.join(tmp, top)
        for dirpath, _, files in os.walk(root):
            for f in files:
                if f.endswith('.js'):
                    p = os.path.join(dirpath, f)
                    r = subprocess.run(['node', '--check', p], capture_output=True)
                    check(r.returncode == 0, 'node --check: ' + safe(os.path.relpath(p, root)) +
                          ('' if r.returncode == 0 else ' -> ' + r.stderr.decode('utf-8', 'replace')[:200]))
                elif platform == 'win' and f.endswith('.bat'):
                    # 每个入口 bat 都要用共享的 lib\find-node.cmd 找 Node（别再内联一套查找逻辑）
                    with open(os.path.join(dirpath, f), 'rb') as fh:
                        bat = fh.read()
                    check(b'lib\\find-node.cmd' in bat, 'bat calls lib\\find-node.cmd: ' + safe(f))
    finally:
        shutil.rmtree(tmp, ignore_errors=True)
    z.close()


zips = sorted(glob.glob(os.path.join(DIST, '*.zip')))
mac = [p for p in zips if '-macOS' in os.path.basename(p)]
win = [p for p in zips if '-macOS' not in os.path.basename(p)]
check(len(mac) == 1 and len(win) == 1, 'found one mac zip and one windows zip: %s' % safe(str([os.path.basename(p) for p in zips])))

if mac and win:
    inspect(mac[0], ['codex-launcher-mac.js', 'lib/launcher-core.js', '使用说明-macOS.txt'], ('.command',), platform='mac')
    inspect(win[0], ['codex-launcher.js', 'lib/launcher-core.js', 'lib/find-node.cmd', '诊断报告.bat',
                     '使用说明.txt'], ('.bat', '.cmd'), platform='win')
    check_fresh(win[0], 'Codex解锁启动器', expect_extracted=True)
    # mac 包没有解压副本（pack-mac.py 只打 zip），但 lib/launcher-core.js 与 windows 包共用，
    # 内容一样要对得上源码
    check_fresh(mac[0], 'Codex解锁启动器-macOS', expect_extracted=False)

print('\n' + ('all checks passed' if bad == 0 else '%d checks failed' % bad))
sys.exit(0 if bad == 0 else 1)
