# -*- coding: utf-8 -*-
"""
Created on Wed Mar 18 17:35:23 2026

@author: 2000
"""

import pandas as pd
import json
import os
from datetime import datetime, timedelta, timezone
import numpy as np

# 假設你的 DataFrame 叫 df
# 欄位範例: Year=2026, DOY=77 (3月18日), Time="12:30:00"

def convert_doy_to_timestamp(year,df):

    first_valid_index = (df[['Day of Year','Hour','Minute','Second']]!= 0).any(axis=1)
    minimun_utc = df[first_valid_index].iloc[0]
    
        
    base_date = datetime(year, 1, 1) \
                + pd.to_timedelta(minimun_utc['Day of Year'].astype(int)-1, unit='d')\
                + pd.to_timedelta(minimun_utc['Hour'].astype(int), unit='h')\
                + pd.to_timedelta(minimun_utc['Minute'].astype(int), unit='m')\
                + pd.to_timedelta(minimun_utc['Second'].astype(int), unit='s')

    df['utc'] = (
        base_date + pd.to_timedelta((df['PPS']-minimun_utc['PPS']).astype(int), unit='s')
    )
    df['time stamp'] = df['utc'].astype('int64') // 10**3

pkl_file = r'C:\Users\2000\Downloads\2026_Day_089\FS8B_2026089235753.vc3_science_pipeline.csv' 
if not os.path.exists(pkl_file):
    print(f"找不到檔案: {pkl_file}")
    exit()

def simplify_science_data(df):
    
    # Define condition and choice
    condition_list = [
        (df['GTM ID'] == 0) & (df['CITIROC'] == 0) & (df['Channel'] >= 0) & (df['Channel'] <= 15),
        (df['GTM ID'] == 0) & (df['CITIROC'] == 0) & (df['Channel'] >= 16) & (df['Channel'] <= 31),
        (df['GTM ID'] == 0) & (df['CITIROC'] == 1) & (df['Channel'] >= 0) & (df['Channel'] <= 15),
        (df['GTM ID'] == 0) & (df['CITIROC'] == 1) & (df['Channel'] >= 16) & (df['Channel'] <= 31),
        (df['GTM ID'] == 1) & (df['CITIROC'] == 0) & (df['Channel'] >= 0) & (df['Channel'] <= 15),
        (df['GTM ID'] == 1) & (df['CITIROC'] == 0) & (df['Channel'] >= 16) & (df['Channel'] <= 31),
        (df['GTM ID'] == 1) & (df['CITIROC'] == 1) & (df['Channel'] >= 0) & (df['Channel'] <= 15),
        (df['GTM ID'] == 1) & (df['CITIROC'] == 1) & (df['Channel'] >= 16) & (df['Channel'] <= 31),
        ]
    choice_list_sensor_name = ['M4', 'M3', 'M2', 'M1', 'S4', 'S3', 'S2', 'S1']
    choice_list_sensor_channel = [0, 16, 0, 16, 0, 16, 0, 16,]
    
    # Select choice by condition
    df['Sensor Name'] = np.select(condition_list, choice_list_sensor_name,default='Unknown')
    df['Sensor Channel Shift'] = np.select(condition_list, choice_list_sensor_channel)
    df['Sensor Channel'] = df['Channel'] - df['Sensor Channel Shift']
    
    # Remove useless data
    df = df.drop(['CITIROC', 'Channel', 'Sensor Channel Shift'], axis=1)
    
    return df

def fix_pps_issue(df_grouped, time_precision_s=3.84E-6):
    
        # Extract fine time
        fine_time = df_grouped['Fine Time'].copy()
        
        # Calculate difference with previous row
        fine_time_diff = fine_time.diff()
        
        # Replace nan to 0 at first row
        fine_time_diff_remove_nan = fine_time_diff.fillna(0)
        
        # Find all return argument
        return_arg_array = np.argwhere(fine_time_diff_remove_nan.to_numpy() < 0)
        
        # Accumulate when encountering return argument
        for return_arg_idx, return_arg in enumerate(return_arg_array):
            
            # Define where start accumulating
            start_row = return_arg[0]
            
            # Define base value to accumulate
            base_add_row = return_arg[0]-1
            
            if return_arg_idx != len(return_arg_array)-1: # not yet final case
                
                # Define where stop accumulating
                end_row = return_arg_array[return_arg_idx+1][0]
                
                # Accumulate data
                fine_time.iloc[start_row:end_row] += fine_time.iloc[base_add_row]
            
            else: # final case
            
                # Accumulate data
                fine_time.iloc[start_row:] += fine_time.iloc[base_add_row]
        
        return fine_time * time_precision_s
df2 = pd.read_csv(pkl_file,sep=';')
convert_doy_to_timestamp(2026,df2)
df2 = simplify_science_data(df2)
#%%

import matplotlib.pyplot as plt
df3 = pd.read_pickle(r'C:\Users\2000\Downloads\2026_Day_089/FS8B_2026089235753.vc3_lg2hg._origin.pkl')
# import numpy as np
# df3['Counts'] = np.ones(len(df3))
# 先把毫秒轉換為秒
# df3['Time Stamp'] = df3['Time Stamp'] // 1000
# hist = df3.groupby(['Time Stamp']).agg({'Counts':'count'})
# # 計算 bins (以 1 秒為間距)
# start_sec = int(time_in_seconds.min() // 1)
# end_sec = int(time_in_seconds.max() // 1) + 1 # 加 1 確保涵蓋到最後一筆資料

# 計算 Histogram
# hist, edge = np.histogram(time_in_seconds, bins=np.arange(start_sec, end_sec, 1))
# plt.plot(hist)
#%%
# --- 關鍵對應區 ---
# 請檢查你的 DataFrame，將引號內改為實際的欄位名稱
timestamp_column = 'Relative Time'  # 你的時間欄位名稱
adc_value_column = 'Temperature' # 你的 ADC 數值欄位名稱
# -----------------

# 2. 轉換格式
telemetry_data = []
for _, row in df3.iterrows():
    # 假設你的 pkl 裡有這三個資訊
    # ms_timestamp = convert_doy_to_timestamp(2026, row['Day of Year'], row['Hour'], row['Minute'], row['Second'])
    ms_timestamp = row['Time Stamp']
    telemetry_data.append({
        "utc": ms_timestamp,
        "Sensor Name": row["Sensor Name"],
        "Sensor Channel": row['Sensor Channel'],
        "ADC value": float(row['Merged ADC'])
    })

# 儲存為 JSON
with open(r'C:\Users\2000\Desktop\master\dashboard\openmct\data\converted_json/ADC.json', 'w') as f:
    json.dump(telemetry_data, f)
print(f'telemetry_data len = {len(telemetry_data)}')