// SPDX-License-Identifier: GPL-3.0-or-later
#include "UserFiles.h"
#include "Wasi.h"
#include <cerrno>
#include <cstring>
#include <dirent.h>
#include <fcntl.h>
#include <sys/stat.h>
#include <unistd.h>

namespace Surge::Wclap::UserFiles
{
namespace
{
// A file being replaced is written beside it first and renamed over it, so a failed
// write never leaves half a patch.
constexpr const char *partialSuffix = ".wclap-partial";
// What one UserFileList frame carries at most; a bigger folder is listed without the
// files past the limit (the host log says which).
constexpr size_t listLimit = size_t(512) << 20;
constexpr int depthLimit = 32;

std::string absolute(const std::string &relative) { return std::string(root) + "/" + relative; }

bool endsWith(const std::string &text, const std::string &suffix)
{
    return text.size() >= suffix.size() &&
           text.compare(text.size() - suffix.size(), suffix.size(), suffix) == 0;
}

struct Lister
{
    Protocol::Writer frame{Protocol::UserFileList};
    uint32_t count{0};
    size_t bytes{0};
    std::vector<std::string> skipped;

    void add(Protocol::UserFileKind kind, const std::string &path, double mtime,
             const std::vector<uint8_t> &data)
    {
        frame.put(uint8_t(kind)).put(uint8_t(0)).put(uint8_t(0)).put(uint8_t(0)).put(mtime);
        frame.put(uint32_t(path.size())).append(path.data(), path.size());
        frame.put(uint32_t(data.size())).append(data.data(), data.size());
        ++count;
    }

    static bool read(const std::string &path, std::vector<uint8_t> &data)
    {
        const int fd = open(path.c_str(), O_RDONLY);
        if (fd < 0)
            return false;
        struct stat info;
        if (fstat(fd, &info) != 0)
        {
            close(fd);
            return false;
        }
        data.resize(size_t(info.st_size));
        size_t at = 0;
        while (at < data.size())
        {
            const auto n = ::read(fd, data.data() + at, data.size() - at);
            if (n <= 0)
                break;
            at += size_t(n);
        }
        close(fd);
        data.resize(at);
        return true;
    }

    void walk(const std::string &relative, int depth)
    {
        if (depth > depthLimit)
            return;
        DIR *dir = opendir(relative.empty() ? root : absolute(relative).c_str());
        if (!dir)
            return;
        std::vector<std::string> names;
        while (auto *entry = readdir(dir))
        {
            const std::string name = entry->d_name;
            if (name != "." && name != ".." && !endsWith(name, partialSuffix))
                names.push_back(name);
        }
        closedir(dir);
        for (const auto &name : names)
        {
            const auto child = relative.empty() ? name : relative + "/" + name;
            struct stat info;
            if (lstat(absolute(child).c_str(), &info) != 0)
                continue;
            const double mtime = double(info.st_mtim.tv_sec) * 1000.0 +
                                 double(info.st_mtim.tv_nsec) / 1000000.0;
            if (S_ISDIR(info.st_mode))
            {
                add(Protocol::UserFolderEntry, child, mtime, {});
                walk(child, depth + 1);
            }
            else if (S_ISREG(info.st_mode))
            {
                std::vector<uint8_t> data;
                if (bytes + size_t(info.st_size) > listLimit)
                {
                    skipped.push_back(child);
                    continue;
                }
                if (read(absolute(child), data))
                {
                    bytes += data.size();
                    add(Protocol::UserFileEntry, child, mtime, data);
                }
            }
        }
    }
};

int writeFile(const std::string &relative, const uint8_t *data, size_t size)
{
    const auto target = absolute(relative), partial = target + partialSuffix;
    const int fd = open(partial.c_str(), O_WRONLY | O_CREAT | O_TRUNC, 0644);
    if (fd < 0)
        return errno;
    size_t at = 0;
    while (at < size)
    {
        const auto n = write(fd, data + at, size - at);
        if (n <= 0)
        {
            const int error = n < 0 ? errno : EIO;
            close(fd);
            unlink(partial.c_str());
            return error;
        }
        at += size_t(n);
    }
    if (fdatasync(fd) != 0 && errno != ENOSYS && errno != EINVAL)
    {
        const int error = errno;
        close(fd);
        unlink(partial.c_str());
        return error;
    }
    close(fd);
    if (rename(partial.c_str(), target.c_str()) != 0)
    {
        const int error = errno;
        unlink(partial.c_str());
        return error;
    }
    return 0;
}

std::vector<uint8_t> done(uint32_t sequence, const std::string &error)
{
    Protocol::Writer frame(Protocol::UserFilesDone, 8 + error.size());
    frame.put(sequence).put(uint8_t(error.empty())).put(uint8_t(0)).put(uint8_t(0)).put(uint8_t(0));
    frame.append(error.data(), error.size());
    return frame.bytes;
}
} // namespace

bool available() { return Wasi::hasPreopen(root); }

bool safeRelativePath(const std::string &path)
{
    if (path.empty() || path.size() > 4096 || path[0] == '/')
        return false;
    size_t start = 0;
    while (start <= path.size())
    {
        auto end = path.find('/', start);
        if (end == std::string::npos)
            end = path.size();
        const auto part = path.substr(start, end - start);
        if (part.empty() || part == "." || part == ".." ||
            part.find_first_of(std::string("\\\0", 2)) != std::string::npos ||
            endsWith(part, partialSuffix))
            return false;
        start = end + 1;
    }
    return true;
}

std::vector<uint8_t> list(std::vector<std::string> *skipped)
{
    Lister lister;
    const bool present = available();
    std::vector<uint8_t> entries;
    if (present)
    {
        lister.walk("", 0);
        if (skipped)
            *skipped = lister.skipped;
        entries = std::move(lister.frame.bytes);
        entries.erase(entries.begin(), entries.begin() + Protocol::headerSize);
    }
    Protocol::Writer frame(Protocol::UserFileList, 8 + entries.size());
    frame.put(uint8_t(present)).put(uint8_t(0)).put(uint8_t(0)).put(uint8_t(0));
    frame.put(lister.count).append(entries.data(), entries.size());
    return frame.bytes;
}

std::vector<uint8_t> apply(Protocol::Reader &frame)
{
    uint32_t sequence = 0, count = 0;
    if (!frame.get(sequence) || !frame.get(count))
        return done(sequence, "Malformed user file operations");
    if (!available())
        return done(sequence, "The host gave Surge XT no user folder");
    for (uint32_t i = 0; i < count; ++i)
    {
        uint8_t op, pad[3];
        uint32_t pathSize, dataSize;
        const uint8_t *pathBytes, *data;
        if (!frame.get(op) || !frame.get(pad) || !frame.get(pathSize) ||
            !frame.getBytes(pathSize, pathBytes) || !frame.get(dataSize) ||
            !frame.getBytes(dataSize, data))
            return done(sequence, "Malformed user file operations");
        const std::string path(reinterpret_cast<const char *>(pathBytes), pathSize);
        if (!safeRelativePath(path))
            return done(sequence, "Refused a path outside the user folder: " + path);
        int error = 0;
        switch (op)
        {
        case Protocol::UserFileWrite:
            error = writeFile(path, data, dataSize);
            break;
        case Protocol::UserFileRemove:
            error = unlink(absolute(path).c_str()) == 0 || errno == ENOENT ? 0 : errno;
            break;
        case Protocol::UserFolderMake:
            error = mkdir(absolute(path).c_str(), 0755) == 0 || errno == EEXIST ? 0 : errno;
            break;
        case Protocol::UserFolderRemove:
            error = rmdir(absolute(path).c_str()) == 0 || errno == ENOENT ? 0 : errno;
            break;
        default:
            return done(sequence, "Unknown user file operation");
        }
        if (error)
            return done(sequence, path + ": " + std::strerror(error));
    }
    return done(sequence, {});
}
} // namespace Surge::Wclap::UserFiles
