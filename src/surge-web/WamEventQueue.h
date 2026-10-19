// SPDX-License-Identifier: GPL-3.0-or-later
#pragma once
#include <algorithm>
#include <array>
#include <atomic>
#include <cmath>
#include <cstdint>
#include <cstring>

namespace Surge::Web
{
// Web Audio Module events for the audio callback. Unlike MidiQueue, WAM events
// may arrive in any time order and far ahead of their AudioContext frame, so
// each block moves both producer rings into a time-sorted pending list and
// delivers only the events that fall inside the block. Nothing here allocates,
// locks or panics: a full ring or pending list drops the new event and counts it.
//
// Two single-producer rings keep each producer lock-free:
//   control  - the browser main thread (WamNode.scheduleEvents, setParameterValues)
//   realtime - the audio worklet thread (events routed through the WAM group)
// The audio callback is the only consumer.
class WamEventQueue
{
  public:
    enum Kind : uint8_t
    {
        Midi = 0,
        Automation = 1,
        Transport = 2,
        Clear = 3 // drops every event scheduled before it; never sends sound-off
    };
    struct Event
    {
        uint64_t frame{}; // absolute AudioContext frame; 0 means "as soon as possible"
        Kind kind{Midi};
        uint8_t length{};
        std::array<uint8_t, 3> bytes{};
        bool playing{};
        uint8_t numerator{4}, denominator{4};
        int32_t parameter{-1};
        float value{};
        double bar{}, barStarted{}, tempo{};
    };
    static constexpr uint32_t ringCapacity = 2048;
    static constexpr uint32_t pendingCapacity = 4096;

    class Ring
    {
      public:
        bool push(const Event &event)
        {
            const auto write = head.load(std::memory_order_relaxed);
            if (write - tail.load(std::memory_order_acquire) >= ringCapacity)
                return false;
            events[write % ringCapacity] = event;
            head.store(write + 1, std::memory_order_release);
            return true;
        }
        template <class Take> void popAll(Take take)
        {
            auto read = tail.load(std::memory_order_relaxed);
            const auto end = head.load(std::memory_order_acquire);
            while (read != end)
                take(events[read++ % ringCapacity]);
            tail.store(read, std::memory_order_release);
        }

      private:
        std::array<Event, ringCapacity> events{};
        alignas(64) std::atomic<uint32_t> head{0};
        alignas(64) std::atomic<uint32_t> tail{0};
    };

    static bool makeMidi(Event &event, int status, int first, int second, double frame)
    {
        if (status < 0x80 || status >= 0xf0 || first < 0 || first > 127 || second < 0 ||
            second > 127)
            return false;
        event = {};
        event.kind = Midi;
        event.frame = toFrame(frame);
        event.bytes = {uint8_t(status), uint8_t(first), uint8_t(second)};
        const int type = status & 0xf0;
        event.length = type == 0xc0 || type == 0xd0 ? 2 : 3;
        return true;
    }
    static bool makeAutomation(Event &event, int parameter, double value, double frame)
    {
        if (parameter < 0 || !std::isfinite(value))
            return false;
        event = {};
        event.kind = Automation;
        event.frame = toFrame(frame);
        event.parameter = parameter;
        event.value = float(std::clamp(value, 0., 1.));
        return true;
    }
    static bool makeTransport(Event &event, bool playing, int numerator, int denominator,
                              double bar, double barStarted, double tempo, double frame)
    {
        if (numerator < 1 || numerator > 32 || denominator < 1 || denominator > 32 ||
            (denominator & (denominator - 1)) || !std::isfinite(bar) ||
            !std::isfinite(barStarted) || !std::isfinite(tempo) || tempo < 1 || tempo > 999)
            return false;
        event = {};
        event.kind = Transport;
        event.frame = toFrame(frame);
        event.playing = playing;
        event.numerator = uint8_t(numerator);
        event.denominator = uint8_t(denominator);
        event.bar = std::max(0., bar);
        event.barStarted = barStarted;
        event.tempo = tempo;
        return true;
    }
    static Event makeClear()
    {
        Event event;
        event.kind = Clear;
        return event;
    }

    bool push(Ring &ring, const Event &event)
    {
        if (ring.push(event))
            return true;
        dropped.fetch_add(1, std::memory_order_relaxed);
        return false;
    }

    // Consumer only. Delivers each event due before firstFrame + frames, in
    // time order (arrival order for equal frames), with its offset in the block.
    // Late events are delivered at offset 0.
    template <class Deliver> void drain(uint64_t firstFrame, uint32_t frames, Deliver deliver)
    {
        auto take = [this](const Event &event) {
            if (event.kind == Clear)
            {
                count = 0;
                return;
            }
            insert(event);
        };
        control.popAll(take);
        realtime.popAll(take);
        const auto end = firstFrame + frames;
        uint32_t due = 0;
        while (due < count && pending[due].frame < end)
        {
            const auto &event = pending[due];
            deliver(event, int(event.frame > firstFrame ? event.frame - firstFrame : 0));
            ++due;
        }
        if (due)
        {
            std::move(pending.begin() + due, pending.begin() + count, pending.begin());
            count -= due;
        }
    }
    uint32_t pendingCount() const { return count; } // consumer only
    uint32_t droppedCount() const { return dropped.load(std::memory_order_relaxed); }

    Ring control, realtime;

  private:
    static uint64_t toFrame(double frame)
    {
        if (!std::isfinite(frame) || frame <= 0)
            return 0;
        return uint64_t(std::min(frame, 9007199254740991.));
    }
    void insert(const Event &event)
    {
        if (count >= pendingCapacity)
        {
            dropped.fetch_add(1, std::memory_order_relaxed);
            return;
        }
        // Stable: an event goes after every pending event with the same frame.
        auto position =
            std::upper_bound(pending.begin(), pending.begin() + count, event,
                             [](const Event &a, const Event &b) { return a.frame < b.frame; });
        std::move_backward(position, pending.begin() + count, pending.begin() + count + 1);
        *position = event;
        ++count;
    }
    std::array<Event, pendingCapacity> pending{};
    uint32_t count{}; // consumer only
    std::atomic<uint32_t> dropped{0};
};
static_assert(std::atomic<uint32_t>::is_always_lock_free);
} // namespace Surge::Web
