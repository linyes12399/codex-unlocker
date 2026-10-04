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
            # Windows：bat 必须纯 ASCII + CRLF；说明文本带 BOM + CRLF 便于记事本识别
            if i.filename.endswith('.bat'):
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
    finally:
        shutil.rmtree(tmp, ignore_errors=True)
    z.close()


zips = sorted(glob.glob(os.path.join(DIST, '*.zip')))
mac = [p for p in zips if '-macOS' in os.path.basename(p)]
win = [p for p in zips if '-macOS' not in os.path.basename(p)]
check(len(mac) == 1 and len(win) == 1, 'found one mac zip and one windows zip: %s' % safe(str([os.path.basename(p) for p in zips])))

if mac and win:
    inspect(mac[0], ['codex-launcher-mac.js', 'lib/launcher-core.js', '使用说明-macOS.txt'], ('.command',), platform='mac')
    inspect(win[0], ['codex-launcher.js', 'lib/launcher-core.js', '使用说明.txt'], ('.bat',), platform='win')

print('\n' + ('all checks passed' if bad == 0 else '%d checks failed' % bad))
sys.exit(0 if bad == 0 else 1)
