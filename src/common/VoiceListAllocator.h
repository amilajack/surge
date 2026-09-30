// SPDX-License-Identifier: GPL-3.0-or-later
#pragma once
#include <cstddef>
#include <new>

namespace Surge
{
// Browser builds keep voice-list nodes in a fixed pool so note-on and release
// never reach the heap from the audio callback. Every access is serialized by
// engine ownership (the audio callback, or control work while audio is
// inactive). Requests beyond the pool, or of another shape, use the heap.
namespace VoiceListPool
{
constexpr std::size_t slotSize = 4 * sizeof(void *), slots = 1024;
struct alignas(std::max_align_t) Slot
{
    union
    {
        Slot *next;
        unsigned char bytes[slotSize];
    };
};
inline Slot storage[slots];
inline Slot *freeList = [] {
    for (std::size_t i = 0; i + 1 < slots; ++i)
        storage[i].next = &storage[i + 1];
    storage[slots - 1].next = nullptr;
    return &storage[0];
}();
inline bool owns(const void *p) { return p >= storage && p < storage + slots; }
} // namespace VoiceListPool

template <class T> struct VoiceListAllocator
{
    using value_type = T;
    VoiceListAllocator() noexcept = default;
    template <class U> VoiceListAllocator(const VoiceListAllocator<U> &) noexcept {}
    T *allocate(std::size_t n)
    {
        using namespace VoiceListPool;
        if (n == 1 && sizeof(T) <= slotSize && alignof(T) <= alignof(Slot) && freeList)
        {
            auto *slot = freeList;
            freeList = slot->next;
            return reinterpret_cast<T *>(slot);
        }
        return static_cast<T *>(::operator new(n * sizeof(T)));
    }
    void deallocate(T *p, std::size_t) noexcept
    {
        using namespace VoiceListPool;
        if (owns(p))
        {
            auto *slot = reinterpret_cast<Slot *>(p);
            slot->next = freeList;
            freeList = slot;
            return;
        }
        ::operator delete(p);
    }
    template <class U> bool operator==(const VoiceListAllocator<U> &) const noexcept { return true; }
    template <class U> bool operator!=(const VoiceListAllocator<U> &) const noexcept { return false; }
};
} // namespace Surge
