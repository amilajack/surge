// SPDX-License-Identifier: GPL-3.0-or-later
// Heap operations made on a thread while it runs the audio callback.
//
// The linker wraps the whole malloc family, so C, C++ and Lua allocations are
// all observed. Inside a callback, requests are served from a real-time pool
// reserved before audio starts: power-of-two size classes with per-class free
// lists, constant time, never touching dlmalloc's lock (which the main thread
// holds during long operations) and never growing memory. A short spinlock
// covers the pool because a loader may release pool blocks while the engine is
// halted. Blocks are freed into the pool from any thread.
//
// "heap" counters record callback requests the pool could not serve (larger
// than its largest class, or exhausted); a real-time-safe engine keeps them at
// zero. "pool" counters record requests the pool served.
#include <emscripten.h>
#include <stdatomic.h>
#include <stddef.h>
#include <stdint.h>
#include <string.h>
void *__real_malloc(size_t);
void *__real_calloc(size_t, size_t);
void *__real_realloc(void *, size_t);
void __real_free(void *);
int __real_posix_memalign(void **, size_t, size_t);
void *__real_aligned_alloc(size_t, size_t);
void *__real_memalign(size_t, size_t);

_Thread_local int surge_audio_callback_depth;
static atomic_uint heapAllocations, heapReleases, poolAllocations, poolReleases;

enum { minimumShift = 5, classCount = 16 }; // 32 B to 1 MiB, header included
typedef struct Header
{
    uint32_t index;  // size class
    uint32_t offset; // from the class block to this header
    uint32_t pad[2]; // keeps user pointers 16-byte aligned
} Header;
typedef struct FreeBlock
{
    struct FreeBlock *next;
} FreeBlock;
static unsigned char *pool;
static size_t poolCapacity, poolUsed;
static FreeBlock *freeLists[classCount];
static atomic_flag poolLock = ATOMIC_FLAG_INIT;

static void lock(void)
{
    while (atomic_flag_test_and_set_explicit(&poolLock, memory_order_acquire))
        ;
}
static void unlock(void) { atomic_flag_clear_explicit(&poolLock, memory_order_release); }
static int owns(const void *p)
{
    return pool && (const unsigned char *)p >= pool && (const unsigned char *)p < pool + poolCapacity;
}

// Reserves the pool. Call from the control thread before audio starts.
EMSCRIPTEN_KEEPALIVE int surge_browser_audio_pool_reserve(size_t bytes)
{
    if (pool)
        return 1;
    unsigned char *reserved = __real_malloc(bytes);
    if (!reserved)
        return 0;
    lock();
    pool = reserved;
    poolCapacity = bytes;
    unlock();
    return 1;
}

static void *poolTake(size_t size, size_t alignment)
{
    const size_t needed = size + sizeof(Header) + (alignment > 16 ? alignment - 16 : 0);
    int index = 0;
    while (index < classCount && ((size_t)1 << (index + minimumShift)) < needed)
        ++index;
    if (index == classCount)
        return NULL;
    const size_t classSize = (size_t)1 << (index + minimumShift);
    unsigned char *block = NULL;
    lock();
    if (freeLists[index])
    {
        block = (unsigned char *)freeLists[index];
        freeLists[index] = freeLists[index]->next;
    }
    else if (poolCapacity - poolUsed >= classSize)
    {
        block = pool + poolUsed;
        poolUsed += classSize;
    }
    unlock();
    if (!block)
        return NULL;
    uintptr_t user = (uintptr_t)block + sizeof(Header);
    if (alignment > 16)
        user = (user + alignment - 1) & ~(uintptr_t)(alignment - 1);
    Header *header = (Header *)user - 1;
    header->index = (uint32_t)index;
    header->offset = (uint32_t)((unsigned char *)header - block);
    atomic_fetch_add_explicit(&poolAllocations, 1, memory_order_relaxed);
    return (void *)user;
}
static size_t poolUsable(void *p)
{
    const Header *header = (const Header *)p - 1;
    return ((size_t)1 << (header->index + minimumShift)) - header->offset - sizeof(Header);
}
static void poolGive(void *p)
{
    Header *header = (Header *)p - 1;
    FreeBlock *block = (FreeBlock *)((unsigned char *)header - header->offset);
    const uint32_t index = header->index;
    lock();
    block->next = freeLists[index];
    freeLists[index] = block;
    unlock();
    atomic_fetch_add_explicit(&poolReleases, 1, memory_order_relaxed);
}
static void *callbackTake(size_t size, size_t alignment)
{
    void *p = poolTake(size ? size : 1, alignment);
    if (!p)
        atomic_fetch_add_explicit(&heapAllocations, 1, memory_order_relaxed);
    return p;
}

void *__wrap_malloc(size_t size)
{
    void *p = surge_audio_callback_depth ? callbackTake(size, 16) : NULL;
    return p ? p : __real_malloc(size);
}
void *__wrap_calloc(size_t count, size_t size)
{
    void *p = surge_audio_callback_depth && (!size || count <= SIZE_MAX / size)
                  ? callbackTake(count * size, 16) : NULL;
    return p ? memset(p, 0, count * size) : __real_calloc(count, size);
}
void __wrap_free(void *p)
{
    if (!p)
        return;
    if (owns(p))
    {
        poolGive(p);
        return;
    }
    if (surge_audio_callback_depth)
        atomic_fetch_add_explicit(&heapReleases, 1, memory_order_relaxed);
    __real_free(p);
}
void *__wrap_realloc(void *p, size_t size)
{
    if (p && owns(p))
    {
        if (size && size <= poolUsable(p))
            return p;
        void *moved = size ? __wrap_malloc(size) : NULL;
        if (size && !moved)
            return NULL;
        if (moved)
            memcpy(moved, p, poolUsable(p) < size ? poolUsable(p) : size);
        poolGive(p);
        return moved;
    }
    if (surge_audio_callback_depth)
    {
        if (!p)
            return __wrap_malloc(size);
        atomic_fetch_add_explicit(&heapAllocations, 1, memory_order_relaxed);
    }
    return __real_realloc(p, size);
}
int __wrap_posix_memalign(void **result, size_t alignment, size_t size)
{
    void *p = surge_audio_callback_depth && alignment <= 4096 ? callbackTake(size, alignment) : NULL;
    if (p)
    {
        *result = p;
        return 0;
    }
    return __real_posix_memalign(result, alignment, size);
}
void *__wrap_aligned_alloc(size_t alignment, size_t size)
{
    void *p = surge_audio_callback_depth && alignment <= 4096 ? callbackTake(size, alignment) : NULL;
    return p ? p : __real_aligned_alloc(alignment, size);
}
void *__wrap_memalign(size_t alignment, size_t size)
{
    void *p = surge_audio_callback_depth && alignment <= 4096 ? callbackTake(size, alignment) : NULL;
    return p ? p : __real_memalign(alignment, size);
}

EMSCRIPTEN_KEEPALIVE unsigned surge_browser_audio_allocations(void) { return atomic_load(&heapAllocations); }
EMSCRIPTEN_KEEPALIVE unsigned surge_browser_audio_releases(void) { return atomic_load(&heapReleases); }
EMSCRIPTEN_KEEPALIVE unsigned surge_browser_audio_pool_allocations(void) { return atomic_load(&poolAllocations); }
EMSCRIPTEN_KEEPALIVE unsigned surge_browser_audio_pool_releases(void) { return atomic_load(&poolReleases); }
EMSCRIPTEN_KEEPALIVE size_t surge_browser_audio_pool_used(void) { return poolUsed; }
EMSCRIPTEN_KEEPALIVE void surge_browser_audio_allocations_reset(void)
{
    atomic_store(&heapAllocations, 0);
    atomic_store(&heapReleases, 0);
    atomic_store(&poolAllocations, 0);
    atomic_store(&poolReleases, 0);
}
