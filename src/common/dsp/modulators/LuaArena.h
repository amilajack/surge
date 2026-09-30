// SPDX-License-Identifier: GPL-3.0-or-later
#pragma once
#include <array>
#include <cstddef>
#include <cstdlib>
#include <cstring>
#include <memory>

namespace Surge::Formula
{
// Allocator for the audio interpreter, so formula evaluation never reaches the
// heap from an audio callback. Lua passes each block's size back on release, so
// blocks need no headers: power-of-two size classes are recycled through free
// lists, and new blocks are carved from one reservation made off the callback.
// Oversized requests, or requests after the reservation is exhausted, use the
// heap and remain correct. The interpreter's owner serializes every call.
class LuaArena
{
  public:
    static constexpr std::size_t minimumClass = 16, classCount = 13; // 16 B to 64 KiB
    explicit LuaArena(std::size_t bytes)
        : storage(static_cast<unsigned char *>(std::malloc(bytes))), capacity(storage ? bytes : 0)
    {
    }
    ~LuaArena() { std::free(storage); }
    LuaArena(const LuaArena &) = delete;
    LuaArena &operator=(const LuaArena &) = delete;

    static void *allocate(void *user, void *block, std::size_t oldSize, std::size_t newSize)
    {
        return static_cast<LuaArena *>(user)->reallocate(block, oldSize, newSize);
    }
    std::size_t reserved() const { return used; }

  private:
    struct FreeBlock
    {
        FreeBlock *next;
    };
    unsigned char *storage;
    std::size_t capacity, used{0};
    std::array<FreeBlock *, classCount> freeLists{};

    bool owns(const void *block) const
    {
        return block >= storage && block < storage + capacity;
    }
    static int classOf(std::size_t size)
    {
        std::size_t classSize = minimumClass;
        for (int index = 0; index < int(classCount); ++index, classSize <<= 1)
            if (size <= classSize)
                return index;
        return -1;
    }
    void *take(std::size_t size)
    {
        const auto index = classOf(size);
        if (index < 0)
            return std::malloc(size);
        if (auto *block = freeLists[index])
        {
            freeLists[index] = block->next;
            return block;
        }
        const auto classSize = minimumClass << index;
        if (capacity - used < classSize)
            return std::malloc(size);
        auto *block = storage + used;
        used += classSize;
        return block;
    }
    void give(void *block, std::size_t size)
    {
        if (!owns(block))
        {
            std::free(block);
            return;
        }
        // A shrunk block may be recorded in a smaller class than its storage; that is safe.
        const auto index = classOf(size);
        auto *freeBlock = static_cast<FreeBlock *>(block);
        freeBlock->next = freeLists[index];
        freeLists[index] = freeBlock;
    }
    void *reallocate(void *block, std::size_t oldSize, std::size_t newSize)
    {
        if (newSize == 0)
        {
            if (block)
                give(block, oldSize);
            return nullptr;
        }
        if (!block)
            return take(newSize); // oldSize is a type tag in this case.
        if (owns(block) && classOf(oldSize) >= 0 && classOf(oldSize) == classOf(newSize))
            return block;
        if (!owns(block) && classOf(newSize) < 0)
            return std::realloc(block, newSize);
        auto *moved = take(newSize);
        if (!moved)
            // Lua requires shrinking to succeed; the original block still fits.
            return newSize <= oldSize ? block : nullptr;
        std::memcpy(moved, block, oldSize < newSize ? oldSize : newSize);
        give(block, oldSize);
        return moved;
    }
};
} // namespace Surge::Formula
