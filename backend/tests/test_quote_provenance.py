from datetime import datetime, timedelta, timezone
from app import kiwoom_gateway as gateway


def test_volume_refresh_does_not_replace_newer_rest_price():
    now=datetime.now(timezone.utc)
    identity={'environment':'fixture','market':'KR','stkCd':'005930','listingVenue':'KOSPI','quoteVenue':'KRX'}
    quote={**identity,'last':100,'volume':10,'status':'snapshot','receivedAt':now.isoformat(),'tradeReceivedAt':now.isoformat()}
    stream={**identity,'last':90,'volume':20,'status':'live','receivedAt':(now+timedelta(seconds=1)).isoformat(),
        'priceReceivedAt':(now-timedelta(seconds=40)).isoformat(),'tradeReceivedAt':(now-timedelta(seconds=40)).isoformat(),
        'volumeReceivedAt':(now+timedelta(seconds=1)).isoformat(),'volumeLive':True}
    result=gateway.merge_stream(quote,stream)
    assert result['last']==100 and result['status']=='snapshot'
    assert result['volume']==20 and result['volumeReceivedAt']==stream['volumeReceivedAt']
    assert result['tradeReceivedAt']==quote['tradeReceivedAt']


def test_new_book_retains_price_source_time():
    now=datetime.now(timezone.utc).isoformat()
    identity={'environment':'fixture','market':'KR','stkCd':'005930','listingVenue':'KOSPI','quoteVenue':'KRX'}
    source={'rawTradeTime':'093000'}
    quote={**identity,'last':100,'receivedAt':now,'tradeReceivedAt':now,'tradeSourceTime':source,'sourceTimestamp':None}
    stream={**identity,'bookReceivedAt':now,'asks':[{'price':101,'qty':2}],'bids':[{'price':99,'qty':3}],
        'bookLive':True,'bookSourceTime':{'rawTradeTime':'093001'}}
    result=gateway.merge_stream(quote,stream)
    assert result['tradeSourceTime']==source
    assert result['bookSourceTime']==stream['bookSourceTime']
    assert result['sourceTimestamp'] is None
