// SPDX-License-Identifier: GPL-3.0-or-later
#include "../../src/surge-web/WamEventQueue.h"
#include <cassert>
#include <limits>
#include <thread>
#include <vector>
using Surge::Web::WamEventQueue;
using Event = WamEventQueue::Event;
struct Delivered
{
    int kind, offset, status, parameter;
};
int main()
{
    static WamEventQueue queue;
    Event event;
    assert(!WamEventQueue::makeMidi(event, 0x70, 60, 100, 0));
    assert(!WamEventQueue::makeMidi(event, 0xf0, 60, 100, 0));
    assert(!WamEventQueue::makeMidi(event, 0x90, 128, 100, 0));
    assert(!WamEventQueue::makeAutomation(event, -1, 0.5, 0));
    assert(!WamEventQueue::makeAutomation(event, 3, std::numeric_limits<double>::quiet_NaN(), 0));
    assert(!WamEventQueue::makeTransport(event, true, 4, 3, 0, 0, 120, 0));
    assert(!WamEventQueue::makeTransport(event, true, 4, 4, 0, 0, 0, 0));

    std::vector<Delivered> delivered;
    auto collect = [&](const Event &e, int offset) {
        delivered.push_back({e.kind, offset, e.bytes[0], e.parameter});
    };

    // Out-of-order future events: a far-future note-off must not delay later,
    // earlier-timed events (MidiQueue would clamp these to non-decreasing time).
    WamEventQueue::makeMidi(event, 0x80, 60, 0, 1000);
    assert(queue.push(queue.control, event));
    WamEventQueue::makeMidi(event, 0x90, 60, 100, 140);
    assert(queue.push(queue.realtime, event));
    WamEventQueue::makeMidi(event, 0xc0, 5, 0, 130);
    assert(queue.push(queue.control, event));
    queue.drain(0, 128, collect);
    assert(delivered.empty());
    assert(queue.pendingCount() == 3);
    queue.drain(128, 128, collect);
    assert(delivered.size() == 2);
    assert(delivered[0].status == 0xc0 && delivered[0].offset == 2);
    assert(delivered[1].status == 0x90 && delivered[1].offset == 12);
    delivered.clear();
    queue.drain(256, 768, collect); // ends at 1024, includes frame 1000
    assert(delivered.size() == 1 && delivered[0].status == 0x80 && delivered[0].offset == 744);
    delivered.clear();

    // Immediate events (frame 0) and late events are delivered at offset 0.
    WamEventQueue::makeAutomation(event, 7, 0.25, 0);
    queue.push(queue.control, event);
    WamEventQueue::makeMidi(event, 0x90, 61, 90, 10);
    queue.push(queue.control, event);
    queue.drain(2048, 128, collect);
    assert(delivered.size() == 2);
    assert(delivered[0].kind == WamEventQueue::Automation && delivered[0].parameter == 7 &&
           delivered[0].offset == 0);
    assert(delivered[1].status == 0x90 && delivered[1].offset == 0);
    delivered.clear();

    // Equal frames keep arrival order.
    for (int note = 0; note < 4; ++note)
    {
        WamEventQueue::makeMidi(event, 0x90, note, 1, 3000);
        queue.push(queue.control, event);
    }
    queue.drain(2944, 128, collect);
    assert(delivered.size() == 4);
    for (int i = 0; i < 4; ++i)
        assert(delivered[i].offset == 56);
    delivered.clear();

    // Clear drops scheduled events only. It never synthesizes sound-off.
    WamEventQueue::makeMidi(event, 0x90, 62, 100, 10000);
    queue.push(queue.control, event);
    queue.push(queue.realtime, WamEventQueue::makeClear());
    WamEventQueue::makeMidi(event, 0x90, 63, 100, 10010);
    queue.push(queue.realtime, event);
    queue.drain(9984, 128, collect);
    assert(delivered.size() == 1 && delivered[0].status == 0x90);
    delivered.clear();

    // Overflow drops and counts, without clearing what is already pending.
    const auto droppedBefore = queue.droppedCount();
    for (uint32_t i = 0; i < WamEventQueue::ringCapacity; ++i)
    {
        WamEventQueue::makeMidi(event, 0x90, 64, 1, 100000 + i);
        assert(queue.push(queue.control, event));
    }
    WamEventQueue::makeMidi(event, 0x90, 64, 1, 100000);
    assert(!queue.push(queue.control, event));
    assert(queue.droppedCount() == droppedBefore + 1);
    queue.drain(20000, 128, collect);
    assert(delivered.empty() && queue.pendingCount() == WamEventQueue::ringCapacity);
    for (uint32_t i = 0; i < WamEventQueue::ringCapacity; ++i)
    {
        WamEventQueue::makeMidi(event, 0x90, 65, 1, 200000);
        assert(queue.push(queue.realtime, event));
    }
    queue.drain(20128, 128, collect);
    assert(queue.pendingCount() == WamEventQueue::pendingCapacity);
    WamEventQueue::makeMidi(event, 0x90, 66, 1, 200000);
    queue.push(queue.control, event);
    queue.drain(20256, 128, collect);
    assert(queue.droppedCount() == droppedBefore + 2);
    queue.push(queue.control, WamEventQueue::makeClear());
    queue.drain(20384, 128, collect);
    assert(queue.pendingCount() == 0 && delivered.empty());

    // Transport events carry their fields through unchanged.
    assert(WamEventQueue::makeTransport(event, true, 7, 8, 3, 1.5, 133, 0));
    queue.push(queue.control, event);
    double tempo = 0;
    int numerator = 0, denominator = 0;
    queue.drain(30000, 128, [&](const Event &e, int) {
        tempo = e.tempo; numerator = e.numerator; denominator = e.denominator;
        assert(e.kind == WamEventQueue::Transport && e.playing && e.bar == 3 && e.barStarted == 1.5);
    });
    assert(tempo == 133 && numerator == 7 && denominator == 8);

    // Two concurrent producers against one consumer lose nothing below capacity.
    static WamEventQueue threaded;
    constexpr int perProducer = 20000;
    std::thread control([] {
        Event e;
        for (int i = 0; i < perProducer;)
        {
            WamEventQueue::makeMidi(e, 0x90, i % 128, 1, 0);
            if (threaded.control.push(e)) ++i;
        }
    });
    std::thread realtime([] {
        Event e;
        for (int i = 0; i < perProducer;)
        {
            WamEventQueue::makeMidi(e, 0x91, i % 128, 1, 0);
            if (threaded.realtime.push(e)) ++i;
        }
    });
    int received = 0;
    uint64_t frame = 0;
    while (received < 2 * perProducer)
    {
        threaded.drain(frame, 128, [&](const Event &, int) { ++received; });
        frame += 128;
    }
    control.join();
    realtime.join();
    assert(received == 2 * perProducer && threaded.droppedCount() == 0);
    return 0;
}
