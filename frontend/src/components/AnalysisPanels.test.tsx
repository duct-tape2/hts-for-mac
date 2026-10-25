import {fireEvent,render,screen,waitFor,cleanup} from '@testing-library/react';
import {afterEach,describe,expect,it,vi} from 'vitest';
import {HistoryPanel,NotesPanel} from './AnalysisPanels';
import {samsung,apple} from '@/test/fixtures';
import {api} from '@/lib/api';
vi.mock('@/lib/api',()=>({api:{chart:vi.fn()},isAbortError:()=>false}));
afterEach(()=>{cleanup();localStorage.clear();vi.clearAllMocks();});
describe('analysis panels',()=>{
 it('bounds rendered rows while preserving access to older history',async()=>{
  const bars=Array.from({length:205},(_,i)=>({t:new Date(Date.UTC(2025,0,i+1)).toISOString().slice(0,10).replaceAll('-',''),o:1,h:3,l:1,c:2,v:10}));
  vi.mocked(api.chart).mockResolvedValueOnce({...samsung,interval:'D',bars,source:'fixture',status:'snapshot',receivedAt:'2026-10-24T00:00:00Z',sourceTimestamp:null,complete:true,adjusted:true,range:{basis:'fixture',start:bars[0].t,end:bars[bars.length-1].t},note:''});
  render(<HistoryPanel instrument={samsung} refreshKey={0}/>);
  await screen.findByText('205개');
  expect(screen.getAllByRole('row')).toHaveLength(101);
  expect(screen.getByText('2025.07.24')).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button',{name:'더 오래된 시세'}));
  expect(screen.getAllByRole('row')).toHaveLength(101);
  expect(screen.queryByText('2025.07.24')).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole('button',{name:'더 오래된 시세'}));
  expect(screen.getAllByRole('row')).toHaveLength(6);
  expect(screen.getByText('2025.01.01')).toBeInTheDocument();
  expect(screen.getByRole('button',{name:'더 오래된 시세'})).toBeDisabled();
 });
 it('stores notes separately per market symbol and restores on return',async()=>{
  const view=render(<NotesPanel instrument={samsung}/>);
  fireEvent.change(screen.getByRole('textbox'),{target:{value:'테스트 메모'}});
  view.rerender(<NotesPanel instrument={apple}/>);
  await waitFor(()=>expect(screen.getByRole('textbox')).toHaveValue(''));
  view.rerender(<NotesPanel instrument={samsung}/>);
  await waitFor(()=>expect(screen.getByRole('textbox')).toHaveValue('테스트 메모'));
 });
 it('shows request failure instead of a stale table or export',async()=>{
  vi.mocked(api.chart).mockRejectedValueOnce(new Error('조회 실패'));
  render(<HistoryPanel instrument={samsung} refreshKey={0}/>);
  expect(await screen.findByRole('alert')).toHaveTextContent('조회 실패');
  expect(screen.getByRole('button',{name:'CSV 내보내기'})).toBeDisabled();
 });
});
