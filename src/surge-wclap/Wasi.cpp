// SPDX-License-Identifier: GPL-3.0-or-later
// File system calls of a standalone Emscripten module, answered by WASI preview1.
//
// Emscripten's standalone runtime implements read, write, seek and close with WASI
// but answers path operations with ENOSYS or EPERM, and anything it leaves out
// becomes an "env" import that WCLAP hosts do not provide. This file resolves
// absolute paths against the host's preopened directories (a host preopens the
// bundle, so the module can read its own files) and maps the calls onto WASI.
// Whatever a host does not grant (writes to a read-only preopen) fails with the
// host's errno. The module has no other files and no working directory but "/".
#include <emscripten/syscalls.h>
#include <wasi/api.h>
#include <cerrno>
#include <cstdarg>
#include <cstdint>
#include <cstring>
#include <dirent.h>
#include <fcntl.h>
#include <string>
#include <sys/stat.h>
#include <unistd.h>
#include <vector>

namespace
{
struct Preopen
{
    int fd;
    std::string path; // normalized absolute directory, "/" for the root
};

std::vector<Preopen> &preopens()
{
    static std::vector<Preopen> found = [] {
        std::vector<Preopen> result;
        for (int fd = 3;; ++fd)
        {
            __wasi_prestat_t prestat;
            if (__wasi_fd_prestat_get(fd, &prestat) != __WASI_ERRNO_SUCCESS)
                break;
            if (prestat.pr_type != __WASI_PREOPENTYPE_DIR)
                continue;
            std::string name(prestat.u.dir.pr_name_len, '\0');
            if (__wasi_fd_prestat_dir_name(fd, reinterpret_cast<uint8_t *>(name.data()),
                                           name.size()) != __WASI_ERRNO_SUCCESS)
                continue;
            name.resize(strnlen(name.c_str(), name.size()));
            if (name.empty() || name == "." || name == "./")
                name = "/";
            if (name[0] != '/')
                name = "/" + name;
            while (name.size() > 1 && name.back() == '/')
                name.pop_back();
            result.push_back({fd, name});
        }
        return result;
    }();
    return found;
}

// Lexical normalization of an absolute path: no ".", ".." or empty segments.
std::string normalize(const char *path)
{
    std::vector<std::string> parts;
    std::string current;
    const std::string input = path[0] == '/' ? path : std::string("/") + path;
    for (size_t i = 0; i <= input.size(); ++i)
    {
        if (i == input.size() || input[i] == '/')
        {
            if (current == "..")
            {
                if (!parts.empty())
                    parts.pop_back();
            }
            else if (!current.empty() && current != ".")
                parts.push_back(current);
            current.clear();
        }
        else
            current += input[i];
    }
    std::string result;
    for (const auto &part : parts)
        result += "/" + part;
    return result.empty() ? "/" : result;
}

// The preopen holding an absolute path, and the path relative to it.
bool resolve(int dirfd, const char *path, int &fd, std::string &relative)
{
    if (!path)
        return false;
    if (path[0] != '/' && dirfd != AT_FDCWD)
    {
        fd = dirfd;
        relative = *path ? path : ".";
        return true;
    }
    const auto absolute = normalize(path);
    const Preopen *best = nullptr;
    for (const auto &preopen : preopens())
    {
        const auto &root = preopen.path;
        const bool inside = root == "/" || absolute == root ||
                            (absolute.compare(0, root.size(), root) == 0 &&
                             absolute.size() > root.size() && absolute[root.size()] == '/');
        if (inside && (!best || root.size() > best->path.size()))
            best = &preopen;
    }
    if (!best)
        return false;
    fd = best->fd;
    relative = best->path == "/" ? absolute.substr(1) : absolute.substr(best->path.size());
    while (!relative.empty() && relative[0] == '/')
        relative.erase(0, 1);
    if (relative.empty())
        relative = ".";
    return true;
}

mode_t modeOf(__wasi_filetype_t type)
{
    switch (type)
    {
    case __WASI_FILETYPE_DIRECTORY:
        return S_IFDIR | 0555;
    case __WASI_FILETYPE_REGULAR_FILE:
        return S_IFREG | 0444;
    case __WASI_FILETYPE_SYMBOLIC_LINK:
        return S_IFLNK | 0777;
    case __WASI_FILETYPE_CHARACTER_DEVICE:
        return S_IFCHR | 0666;
    case __WASI_FILETYPE_BLOCK_DEVICE:
        return S_IFBLK | 0666;
    default:
        return S_IFSOCK | 0666;
    }
}

void fill(struct stat *buf, const __wasi_filestat_t &file)
{
    std::memset(buf, 0, sizeof(*buf));
    buf->st_dev = file.dev;
    buf->st_ino = file.ino;
    buf->st_mode = modeOf(file.filetype);
    buf->st_nlink = file.nlink;
    buf->st_size = file.size;
    buf->st_blksize = 4096;
    buf->st_blocks = (file.size + 511) / 512;
    buf->st_atim.tv_sec = file.atim / 1000000000ull;
    buf->st_atim.tv_nsec = file.atim % 1000000000ull;
    buf->st_mtim.tv_sec = file.mtim / 1000000000ull;
    buf->st_mtim.tv_nsec = file.mtim % 1000000000ull;
    buf->st_ctim.tv_sec = file.ctim / 1000000000ull;
    buf->st_ctim.tv_nsec = file.ctim % 1000000000ull;
}

int pathStat(int dirfd, const char *path, struct stat *buf, bool follow)
{
    int fd;
    std::string relative;
    if (!resolve(dirfd, path, fd, relative))
        return -ENOENT;
    __wasi_filestat_t file;
    const auto error = __wasi_path_filestat_get(fd, follow ? __WASI_LOOKUPFLAGS_SYMLINK_FOLLOW : 0,
                                                relative.c_str(), relative.size(), &file);
    if (error != __WASI_ERRNO_SUCCESS)
        return -int(error);
    fill(buf, file);
    return 0;
}

// fd_readdir resumes from a cookie, getdents from the descriptor's position.
std::vector<__wasi_dircookie_t> &cookies()
{
    static std::vector<__wasi_dircookie_t> list;
    return list;
}
} // namespace

extern "C"
{
    int __syscall_openat(int dirfd, const char *path, int flags, ...)
    {
        int base;
        std::string relative;
        if (!resolve(dirfd, path, base, relative))
            return -ENOENT;
        __wasi_oflags_t oflags = 0;
        if (flags & O_CREAT)
            oflags |= __WASI_OFLAGS_CREAT;
        if (flags & O_EXCL)
            oflags |= __WASI_OFLAGS_EXCL;
        if (flags & O_TRUNC)
            oflags |= __WASI_OFLAGS_TRUNC;
        if (flags & O_DIRECTORY)
            oflags |= __WASI_OFLAGS_DIRECTORY;
        __wasi_fdflags_t fdflags = 0;
        if (flags & O_APPEND)
            fdflags |= __WASI_FDFLAGS_APPEND;
        const int access = flags & O_ACCMODE;
        __wasi_rights_t rights = __WASI_RIGHTS_FD_SEEK | __WASI_RIGHTS_FD_TELL |
                                 __WASI_RIGHTS_FD_FILESTAT_GET | __WASI_RIGHTS_FD_FDSTAT_SET_FLAGS |
                                 __WASI_RIGHTS_FD_ADVISE | __WASI_RIGHTS_FD_READDIR |
                                 __WASI_RIGHTS_PATH_OPEN | __WASI_RIGHTS_PATH_FILESTAT_GET |
                                 __WASI_RIGHTS_PATH_READLINK | __WASI_RIGHTS_POLL_FD_READWRITE;
        if (access != O_WRONLY)
            rights |= __WASI_RIGHTS_FD_READ;
        if (access == O_WRONLY || access == O_RDWR)
            rights |= __WASI_RIGHTS_FD_WRITE | __WASI_RIGHTS_FD_DATASYNC | __WASI_RIGHTS_FD_SYNC |
                      __WASI_RIGHTS_FD_ALLOCATE | __WASI_RIGHTS_FD_FILESTAT_SET_SIZE |
                      __WASI_RIGHTS_FD_FILESTAT_SET_TIMES;
        // Directories pass every right on; the host still limits what a preopen grants.
        const __wasi_rights_t inheriting = ~__wasi_rights_t(0);
        __wasi_fd_t opened;
        const auto error = __wasi_path_open(
            base, (flags & O_NOFOLLOW) ? 0 : __WASI_LOOKUPFLAGS_SYMLINK_FOLLOW, relative.c_str(),
            relative.size(), oflags, rights, inheriting, fdflags, &opened);
        if (error != __WASI_ERRNO_SUCCESS)
            return -int(error);
        auto &list = cookies();
        if (opened >= list.size())
            list.resize(opened + 1);
        list[opened] = 0;
        return int(opened);
    }

    int __syscall_stat64(const char *path, struct stat *buf)
    {
        return pathStat(AT_FDCWD, path, buf, true);
    }

    int __syscall_lstat64(const char *path, struct stat *buf)
    {
        return pathStat(AT_FDCWD, path, buf, false);
    }

    int __syscall_fstat64(int fd, struct stat *buf)
    {
        __wasi_filestat_t file;
        const auto error = __wasi_fd_filestat_get(fd, &file);
        if (error != __WASI_ERRNO_SUCCESS)
            return -int(error);
        fill(buf, file);
        return 0;
    }

    int __syscall_newfstatat(int dirfd, const char *path, struct stat *buf, int flags)
    {
        if ((flags & AT_EMPTY_PATH) && (!path || !*path))
            return __syscall_fstat64(dirfd, buf);
        return pathStat(dirfd, path, buf, !(flags & AT_SYMLINK_NOFOLLOW));
    }

    int __syscall_faccessat(int dirfd, const char *path, int amode, int flags)
    {
        struct stat buf;
        return pathStat(dirfd, path, &buf, !(flags & AT_SYMLINK_NOFOLLOW));
    }

    int __syscall_getdents64(int fd, void *dirp, size_t count)
    {
        auto &list = cookies();
        if (fd < 0 || size_t(fd) >= list.size())
            list.resize(size_t(fd < 0 ? 0 : fd) + 1);
        // Read whole WASI entries; a name split at the buffer end is read again.
        std::vector<uint8_t> raw(count < 4096 ? 4096 : count);
        __wasi_size_t used = 0;
        auto error = __wasi_fd_readdir(fd, raw.data(), raw.size(), list[fd], &used);
        if (error != __WASI_ERRNO_SUCCESS)
            return -int(error);
        auto *out = static_cast<uint8_t *>(dirp);
        size_t written = 0, at = 0;
        while (at + sizeof(__wasi_dirent_t) <= used)
        {
            __wasi_dirent_t entry;
            std::memcpy(&entry, raw.data() + at, sizeof(entry));
            if (at + sizeof(entry) + entry.d_namlen > used)
                break;
            const size_t length =
                (offsetof(struct dirent, d_name) + entry.d_namlen + 1 + 7) & ~size_t(7);
            if (written + length > count)
                break;
            auto *record = reinterpret_cast<struct dirent *>(out + written);
            record->d_ino = entry.d_ino;
            record->d_off = off_t(entry.d_next);
            record->d_reclen = (unsigned short)length;
            record->d_type = (unsigned char)(IFTODT(modeOf(entry.d_type)));
            std::memcpy(record->d_name, raw.data() + at + sizeof(entry), entry.d_namlen);
            record->d_name[entry.d_namlen] = 0;
            written += length;
            list[fd] = entry.d_next;
            at += sizeof(entry) + entry.d_namlen;
        }
        if (!written && at < used)
            return -EINVAL; // one name larger than the caller's buffer
        return int(written);
    }

    int __syscall_getcwd(char *buf, size_t size)
    {
        if (size < 2)
            return -ERANGE;
        std::memcpy(buf, "/", 2);
        return 2;
    }

    int __syscall_chdir(const char *path) { return -EPERM; }
    int __syscall_fchdir(int fd) { return -EPERM; }

    int __syscall_readlinkat(int dirfd, const char *path, char *buf, size_t bufsize)
    {
        int fd;
        std::string relative;
        if (!resolve(dirfd, path, fd, relative))
            return -ENOENT;
        __wasi_size_t used = 0;
        const auto error = __wasi_path_readlink(fd, relative.c_str(), relative.size(),
                                                reinterpret_cast<uint8_t *>(buf), bufsize, &used);
        return error == __WASI_ERRNO_SUCCESS ? int(used) : -int(error);
    }

    int __syscall_mkdirat(int dirfd, const char *path, mode_t mode)
    {
        int fd;
        std::string relative;
        if (!resolve(dirfd, path, fd, relative))
            return -EROFS;
        const auto error = __wasi_path_create_directory(fd, relative.c_str(), relative.size());
        return error == __WASI_ERRNO_SUCCESS ? 0 : -int(error);
    }

    int __syscall_unlinkat(int dirfd, const char *path, int flags)
    {
        int fd;
        std::string relative;
        if (!resolve(dirfd, path, fd, relative))
            return -ENOENT;
        const auto error = (flags & AT_REMOVEDIR)
                               ? __wasi_path_remove_directory(fd, relative.c_str(), relative.size())
                               : __wasi_path_unlink_file(fd, relative.c_str(), relative.size());
        return error == __WASI_ERRNO_SUCCESS ? 0 : -int(error);
    }

    int __syscall_rmdir(const char *path)
    {
        return __syscall_unlinkat(AT_FDCWD, path, AT_REMOVEDIR);
    }

    int __syscall_renameat(int olddirfd, const char *oldpath, int newdirfd, const char *newpath)
    {
        int from, to;
        std::string source, target;
        if (!resolve(olddirfd, oldpath, from, source) || !resolve(newdirfd, newpath, to, target))
            return -ENOENT;
        const auto error = __wasi_path_rename(from, source.c_str(), source.size(), to,
                                              target.c_str(), target.size());
        return error == __WASI_ERRNO_SUCCESS ? 0 : -int(error);
    }

    int __syscall_ftruncate64(int fd, off_t length)
    {
        const auto error = __wasi_fd_filestat_set_size(fd, __wasi_filesize_t(length));
        return error == __WASI_ERRNO_SUCCESS ? 0 : -int(error);
    }

    int __syscall_truncate64(const char *path, off_t length)
    {
        const int fd = __syscall_openat(AT_FDCWD, path, O_WRONLY);
        if (fd < 0)
            return fd;
        const int result = __syscall_ftruncate64(fd, length);
        __wasi_fd_close(fd);
        return result;
    }

    int __syscall_fdatasync(int fd)
    {
        const auto error = __wasi_fd_datasync(fd);
        return error == __WASI_ERRNO_SUCCESS ? 0 : -int(error);
    }

    int __syscall_fcntl64(int fd, int cmd, ...)
    {
        switch (cmd)
        {
        case F_GETFD:
        case F_SETFD:
            return 0;
        case F_GETFL:
        {
            __wasi_fdstat_t stat;
            const auto error = __wasi_fd_fdstat_get(fd, &stat);
            if (error != __WASI_ERRNO_SUCCESS)
                return -int(error);
            int flags = 0;
            const bool reads = stat.fs_rights_base & __WASI_RIGHTS_FD_READ;
            const bool writes = stat.fs_rights_base & __WASI_RIGHTS_FD_WRITE;
            flags |= reads && writes ? O_RDWR : writes ? O_WRONLY : O_RDONLY;
            if (stat.fs_flags & __WASI_FDFLAGS_APPEND)
                flags |= O_APPEND;
            return flags;
        }
        case F_SETFL:
            return 0;
        default:
            return -EINVAL;
        }
    }

    int __syscall_ioctl(int fd, int request, ...) { return -ENOTTY; }
    int __syscall_dup(int fd) { return -ENOSYS; }
    int __syscall_dup3(int oldfd, int newfd, int flags) { return -ENOSYS; }
    int __syscall_chmod(const char *path, mode_t mode) { return -EPERM; }
    int __syscall_fchmod(int fd, mode_t mode) { return -EPERM; }
    int __syscall_fchmodat2(int dirfd, const char *path, mode_t mode, int flags) { return -EPERM; }
    int __syscall_fchown32(int fd, uid_t owner, gid_t group) { return -EPERM; }
    int __syscall_fchownat(int dirfd, const char *path, uid_t owner, gid_t group, int flags)
    {
        return -EPERM;
    }
    int __syscall_utimensat(int dirfd, const char *path, const struct timespec times[2], int flags)
    {
        return -EPERM;
    }
    int __syscall_symlinkat(const char *target, int newdirfd, const char *linkpath)
    {
        return -EPERM;
    }
    int __syscall_statfs64(const char *path, size_t size, struct statfs *buf) { return -ENOSYS; }
    int __syscall_fstatfs64(int fd, size_t size, struct statfs *buf) { return -ENOSYS; }
    int __syscall_fadvise64(int fd, off_t offset, off_t len, int advice) { return 0; }
    int __syscall_fallocate(int fd, int mode, off_t offset, off_t len) { return -ENOSYS; }
    int __syscall_pipe2(int fd[2], int flags) { return -ENOSYS; }
    int __syscall_poll(struct pollfd *fds, nfds_t nfds, int timeout) { return -ENOSYS; }
    int __syscall_uname(struct utsname *buf) { return -ENOSYS; }
    pid_t __syscall_getpid(void) { return 42; }
    uid_t __syscall_geteuid32(void) { return 0; }
    uid_t __syscall_getuid32(void) { return 0; }
    gid_t __syscall_getgid32(void) { return 0; }
    gid_t __syscall_getegid32(void) { return 0; }
    // system(): there is no shell. (The engine only calls it to open folders.)
    int _emscripten_system(const char *command) { return command ? -ENOSYS : 0; }

    // Emscripten's standalone getentropy() aborts. Entropy is the host's.
    int getentropy(void *buffer, size_t length)
    {
        if (length > 256)
        {
            errno = EIO;
            return -1;
        }
        if (__wasi_random_get(static_cast<uint8_t *>(buffer), length) != __WASI_ERRNO_SUCCESS)
        {
            errno = EIO;
            return -1;
        }
        return 0;
    }
}
