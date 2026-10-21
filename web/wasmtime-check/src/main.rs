//! Renders a Surge XT patch with the Surge XT WCLAP on wasmtime, configured as the
//! DAW's desktop host (crates/daw-native/src/plugin/wclap/runtime.rs): SIMD, relaxed
//! SIMD (deterministic), standard exceptions. WASI preopens the bundle as "/" and a
//! fresh directory as "/user"; random_get draws the splitmix64 stream of the test
//! host (web/wclap/host/wasi.mjs) with the same seed. Prints the SHA-256 of the
//! output of a chord held for 1,500 blocks of 64 frames and released for 1,500, as
//! the V8 renderer of web/scripts/wclap-wasmtime-parity.mjs does.
//!
//!   surge-wclap-wasmtime-check BUNDLE USERDIR PATCH.fxp KEY [SEED]
//!
//! web/scripts/wclap-wasmtime-parity.mjs builds it and compares every render with V8.
use sha2::{Digest, Sha256};
use std::convert::Infallible;
use wasmtime::*;
use wasmtime::error::Context as _;
use wasmtime_wasi::p1::WasiP1Ctx;

struct SplitMix(u64, std::collections::VecDeque<u8>);
impl rand_core::TryRng for SplitMix {
    type Error = Infallible;
    // wasmtime-wasi draws random_get bytes one value at a time (u8 from next_u32):
    // hand out the JS host's byte stream in order.
    fn try_next_u32(&mut self) -> Result<u32, Infallible> {
        if self.1.is_empty() {
            self.0 = self.0.wrapping_add(0x9e3779b97f4a7c15);
            let mut z = self.0;
            z = (z ^ (z >> 30)).wrapping_mul(0xbf58476d1ce4e5b9);
            z = (z ^ (z >> 27)).wrapping_mul(0x94d049bb133111eb);
            z ^= z >> 31;
            self.1.extend(z.to_le_bytes());
        }
        Ok(self.1.pop_front().unwrap() as u32)
    }
    fn try_next_u64(&mut self) -> Result<u64, Infallible> {
        Ok(self.try_next_u32()? as u64 | (self.try_next_u32()? as u64) << 32)
    }
    fn try_fill_bytes(&mut self, dst: &mut [u8]) -> Result<(), Infallible> {
        for b in dst {
            *b = self.try_next_u32()? as u8;
        }
        Ok(())
    }
}

struct State {
    wasi: WasiP1Ctx,
    events: Vec<i32>,
    read: Vec<u8>,
    at: usize,
    requests: u32,
}

fn config() -> Result<Config> {
    let mut config = Config::new();
    config
        .cranelift_opt_level(OptLevel::Speed)
        .wasm_simd(true)
        .wasm_relaxed_simd(true)
        .relaxed_simd_deterministic(true)
        .wasm_threads(true)
        .shared_memory(true)
        .wasm_exceptions(true)
        .parallel_compilation(true)
        .max_wasm_stack(512 << 10);
    Ok(config)
}

fn main() -> Result<()> {
    let args: Vec<String> = std::env::args().collect();
    if args.len() < 5 {
        bail!("usage: {} BUNDLE USERDIR PATCH.fxp KEY [SEED]", args[0]);
    }
    let (bundle, user, patch) = (&args[1], &args[2], &args[3]);
    let key: i32 = args[4].parse()?;
    let seed: u64 = args.get(5).map(|s| s.parse()).transpose()?.unwrap_or(1);

    let engine = Engine::new(&config()?)?;
    let started = std::time::Instant::now();
    let module = Module::from_file(&engine, format!("{bundle}/module.wasm"))?;
    eprintln!("compiled in {:?}", started.elapsed());

    let mut linker: Linker<State> = Linker::new(&engine);
    wasmtime_wasi::p1::add_to_linker_sync(&mut linker, |s: &mut State| &mut s.wasi)?;
    let wasi = wasmtime_wasi::WasiCtxBuilder::new()
        .preopened_dir(bundle, "/", wasmtime_wasi::FsPerms::ReadOnly)?
        .preopened_dir(user, "/user", wasmtime_wasi::FsPerms::ReadWrite)?
        .secure_random(SplitMix(seed, Default::default()))
        .build_p1();
    let mut store = Store::new(&engine, State { wasi, events: vec![], read: vec![], at: 0, requests: 0 });
    let instance = linker.instantiate(&mut store, &module)?;
    if let Ok(init) = instance.get_typed_func::<(), ()>(&mut store, "_initialize") {
        init.call(&mut store, ())?;
    }
    let memory = instance.get_memory(&mut store, "memory").context("memory")?;
    let table = instance.get_table(&mut store, "__indirect_function_table").context("table")?;
    let malloc = instance.get_typed_func::<i32, i32>(&mut store, "malloc")?;
    let entry = instance.get_global(&mut store, "clap_entry").context("clap_entry")?.get(&mut store).i32().context("entry")?;

    // Host functions in the module's table.
    let host_funcs = vec![
        Func::wrap(&mut store, |_: Caller<'_, State>, _: i32, _: i32| -> i32 { 0 }), // get_extension
        Func::wrap(&mut store, |_: Caller<'_, State>, _: i32| {}),                    // request_restart
        Func::wrap(&mut store, |mut c: Caller<'_, State>, _: i32| c.data_mut().requests += 1), // request_process
        Func::wrap(&mut store, |_: Caller<'_, State>, _: i32| {}),                    // request_callback
        Func::wrap(&mut store, |c: Caller<'_, State>, _: i32| -> i32 { c.data().events.len() as i32 }), // events size
        Func::wrap(&mut store, |c: Caller<'_, State>, _: i32, i: i32| -> i32 { c.data().events[i as usize] }), // events get
        Func::wrap(&mut store, |_: Caller<'_, State>, _: i32, _: i32| -> i32 { 1 }), // try_push
        Func::wrap(&mut store, move |mut c: Caller<'_, State>, _: i32, buffer: i32, size: i64| -> i64 {
            let mem = c.get_export("memory").and_then(|e| e.into_memory()).unwrap();
            let (data, state) = mem.data_and_store_mut(&mut c);
            let n = (size as usize).min(state.read.len() - state.at);
            data[buffer as usize..buffer as usize + n].copy_from_slice(&state.read[state.at..state.at + n]);
            state.at += n;
            n as i64
        }), // istream read
    ];
    let base = table.grow(&mut store, host_funcs.len() as u64, Ref::Func(None))?;
    for (i, f) in host_funcs.iter().enumerate() {
        table.set(&mut store, base + i as u64, Ref::Func(Some(*f)))?;
    }
    let idx = |i: usize| (base + i as u64) as u32;

    let call = |store: &mut Store<State>, index: u32| -> Result<Func> {
        match table.get(&mut *store, index as u64) {
            Some(Ref::Func(Some(f))) => Ok(f),
            _ => Err(format_err!("no function at {index}")),
        }
    };
    let u32_at = |store: &Store<State>, at: i32| -> u32 {
        u32::from_le_bytes(memory.data(store)[at as usize..at as usize + 4].try_into().unwrap())
    };
    let put = |store: &mut Store<State>, at: i32, bytes: &[u8]| {
        memory.data_mut(store)[at as usize..at as usize + bytes.len()].copy_from_slice(bytes);
    };
    let cstr = |store: &mut Store<State>, text: &str| -> Result<i32> {
        let p = malloc.call(&mut *store, text.len() as i32 + 1)?;
        let mut bytes = text.as_bytes().to_vec();
        bytes.push(0);
        put(store, p, &bytes);
        Ok(p)
    };

    // clap_host
    let host = malloc.call(&mut store, 48)?;
    let strings = ["wasmtime check", "Surge", "https://github.com/amilajack/surge", "1.0.0"].map(|s| cstr(&mut store, s));
    let mut words = vec![1u32, 2, 7, host as u32];
    for s in strings {
        words.push(s? as u32);
    }
    words.extend([idx(0), idx(1), idx(2), idx(3)]);
    let bytes: Vec<u8> = words.iter().flat_map(|w| w.to_le_bytes()).collect();
    put(&mut store, host, &bytes);

    // clap_entry.init("/"), the plug-in factory, create, init, activate.
    let root = cstr(&mut store, "/")?;
    let init = { let i = u32_at(&store, entry + 12); call(&mut store, i)? }.typed::<i32, i32>(&store)?;
    if init.call(&mut store, root)? == 0 {
        bail!("clap_entry.init failed");
    }
    let factory_id = cstr(&mut store, "clap.plugin-factory")?;
    let factory = { let i = u32_at(&store, entry + 20); call(&mut store, i)? }.typed::<i32, i32>(&store)?.call(&mut store, factory_id)?;
    let plugin_id = cstr(&mut store, "org.surge-synth-team.surge-xt")?;
    let plugin = { let i = u32_at(&store, factory + 8); call(&mut store, i)? }
        .typed::<(i32, i32, i32), i32>(&store)?
        .call(&mut store, (factory, host, plugin_id))?;
    if plugin == 0 {
        bail!("create_plugin failed");
    }
    let method = |store: &mut Store<State>, offset: i32| -> Result<Func> { call(store, u32_at(store, plugin + offset)) };
    if method(&mut store, 8)?.typed::<i32, i32>(&store)?.call(&mut store, plugin)? == 0 {
        bail!("plugin init failed");
    }
    if method(&mut store, 16)?.typed::<(i32, f64, i32, i32), i32>(&store)?.call(&mut store, (plugin, 48000.0, 64, 64))? == 0 {
        bail!("activate failed");
    }
    // clap.state load of the patch's chunk (the .fxp less its 60-byte header).
    let state_id = cstr(&mut store, "clap.state")?;
    let state_ext = method(&mut store, 40)?.typed::<(i32, i32), i32>(&store)?.call(&mut store, (plugin, state_id))?;
    let fxp = std::fs::read(patch)?;
    store.data_mut().read = fxp[60..].to_vec();
    store.data_mut().at = 0;
    let stream = malloc.call(&mut store, 8)?;
    put(&mut store, stream, &[0u32.to_le_bytes(), idx(7).to_le_bytes()].concat());
    let load = { let i = u32_at(&store, state_ext + 4); call(&mut store, i)? }.typed::<(i32, i32), i32>(&store)?;
    if load.call(&mut store, (plugin, stream))? == 0 {
        bail!("state load failed");
    }
    if method(&mut store, 24)?.typed::<i32, i32>(&store)?.call(&mut store, plugin)? == 0 {
        bail!("start_processing failed");
    }

    // clap_process with one stereo output and event lists.
    let frames = 64usize;
    let process = malloc.call(&mut store, 40)?;
    let outputs = malloc.call(&mut store, 24)?;
    let pointers = malloc.call(&mut store, 8)?;
    let left = malloc.call(&mut store, (frames * 4) as i32)?;
    let right = malloc.call(&mut store, (frames * 4) as i32)?;
    let in_events = malloc.call(&mut store, 12)?;
    let out_events = malloc.call(&mut store, 8)?;
    let event_area = malloc.call(&mut store, 24 * 3)?;
    put(&mut store, pointers, &[(left as u32).to_le_bytes(), (right as u32).to_le_bytes()].concat());
    put(&mut store, outputs, &[(pointers as u32).to_le_bytes(), 0u32.to_le_bytes(), 2u32.to_le_bytes(), 0u32.to_le_bytes(), [0; 4], [0; 4]].concat());
    put(&mut store, in_events, &[(in_events as u32).to_le_bytes(), idx(4).to_le_bytes(), idx(5).to_le_bytes()].concat());
    put(&mut store, out_events, &[(out_events as u32).to_le_bytes(), idx(6).to_le_bytes()].concat());
    let process_fn = method(&mut store, 36)?.typed::<(i32, i32), i32>(&store)?;
    let mut hash = Sha256::new();
    let midi = |store: &mut Store<State>, status: u8, velocity: u8| -> Vec<i32> {
        (0..3)
            .map(|i| {
                let at = event_area + 24 * i;
                let mut e = vec![0u8; 24];
                e[0..4].copy_from_slice(&24u32.to_le_bytes());
                e[10..12].copy_from_slice(&10u16.to_le_bytes()); // CLAP_EVENT_MIDI
                e[18] = status;
                e[19] = (key + [0, 4, 7][i as usize]) as u8;
                e[20] = velocity;
                put(store, at, &e);
                at
            })
            .collect()
    };
    let started = std::time::Instant::now();
    for block in 0..3000u64 {
        let events = match block {
            0 => midi(&mut store, 0x90, 100),
            1500 => midi(&mut store, 0x80, 0),
            _ => vec![],
        };
        store.data_mut().events = events;
        let mut p = vec![];
        p.extend((block * frames as u64).to_le_bytes());
        p.extend((frames as u32).to_le_bytes());
        p.extend(0u32.to_le_bytes()); // transport
        p.extend(0u32.to_le_bytes()); // audio inputs
        p.extend((outputs as u32).to_le_bytes());
        p.extend(0u32.to_le_bytes());
        p.extend(1u32.to_le_bytes());
        p.extend((in_events as u32).to_le_bytes());
        p.extend((out_events as u32).to_le_bytes());
        put(&mut store, process, &p);
        let status = process_fn.call(&mut store, (plugin, process))?;
        if status == 0 {
            bail!("process error at block {block}");
        }
        let data = memory.data(&store);
        hash.update(&data[left as usize..left as usize + frames * 4]);
        hash.update(&data[right as usize..right as usize + frames * 4]);
    }
    let elapsed = started.elapsed();
    let digest = hash.finalize();
    let hex: String = digest.iter().map(|b| format!("{b:02x}")).collect();
    println!("{}", &hex[..16]);
    eprintln!("3000 blocks in {:?} ({:.2} µs per block)", elapsed, elapsed.as_secs_f64() * 1e6 / 3000.0);
    Ok(())
}
