// SPDX-License-Identifier: GPL-3.0-or-later
(() => {
  globalThis.SurgeTuningLibrary={async show(){
    document.querySelector('#surge-tuning-library')?.close();
    const previous=document.activeElement,dialog=document.createElement('dialog');
    dialog.id='surge-tuning-library';dialog.setAttribute('aria-label','Factory tuning library');
    dialog.style.cssText='width:min(850px,90vw);max-height:80vh;background:#202328;color:white;padding:16px;border:1px solid #888';
    const heading=document.createElement('h2');heading.textContent='Factory tuning library';
    const hint=document.createElement('p');hint.textContent='Load a scale or keyboard mapping into Surge, or download a copy.';
    const search=document.createElement('input');search.type='search';search.setAttribute('aria-label','Search factory tunings');search.style.width='95%';
    const message=document.createElement('p');message.setAttribute('role','status');
    const error=document.createElement('p');error.setAttribute('role','alert');
    const list=document.createElement('ul');list.style.cssText='max-height:45vh;overflow:auto';
    const close=document.createElement('button');close.textContent='Close tuning library';close.onclick=()=>dialog.close();
    dialog.append(heading,hint,search,message,error,list,close);
    dialog.addEventListener('close',()=>{dialog.remove();if(previous?.isConnected)previous.focus();},{once:true});
    document.body.append(dialog);dialog.showModal();search.focus();message.textContent='Loading factory index…';
    try{
      await SurgeFactory.ready;
      if(!SurgeFactory.library)throw Error('Factory index is unavailable. Reload to retry.');
      if(!dialog.isConnected)return;
      const library=SurgeFactory.library;
      const render=()=>{
        const entries=library.search(search.value).filter(entry=>entry.path.startsWith('tuning_library/'));
        list.replaceChildren();message.textContent=`${entries.length} files`;
        for(const entry of entries){
          const row=document.createElement('li'),button=document.createElement('button');
          button.textContent=entry.path.slice('tuning_library/'.length);button.setAttribute('aria-label','Download '+button.textContent);
          button.onclick=async()=>{
            button.disabled=true;error.textContent='';message.textContent='Downloading '+button.textContent;
            let url;
            try{
              const bytes=await library.bytes(entry.path);
              if(!dialog.isConnected)return;
              url=URL.createObjectURL(new Blob([bytes],{type:'application/octet-stream'}));
              const link=document.createElement('a');link.href=url;link.download=entry.path.split('/').pop();
              dialog.append(link);link.click();link.remove();message.textContent='Download started: '+link.download;
            }catch(reason){error.textContent='Unable to download: '+String(reason);}
            finally{button.disabled=false;if(url)setTimeout(()=>URL.revokeObjectURL(url),1000);}
          };
          const kind=entry.extension==='.scl'?'scale':entry.extension==='.kbm'?'mapping':null;
          if(kind){
            // Installs the verified file under /factory, then applies it with the Tuning menu's loader.
            const load=document.createElement('button');load.textContent='Load';
            load.setAttribute('aria-label',`Load ${kind} ${button.textContent}`);
            load.onclick=async()=>{
              load.disabled=true;error.textContent='';message.textContent='Loading '+button.textContent;
              try{
                const path=await library.install(entry.path,FS);
                if(!dialog.isConnected)return;
                if(!Module.ccall('surge_browser_load_tuning','number',['string'],[path]))throw Error('The tuning could not be applied');
                message.textContent=`Loaded ${kind}: `+button.textContent;
              }catch(reason){error.textContent='Unable to load: '+String(reason);}
              finally{load.disabled=false;}
            };
            row.append(load);
          }
          row.append(button);list.append(row);
        }
      };
      search.oninput=render;render();
    }catch(reason){message.textContent='';error.textContent=String(reason);}
  }};
})();
