import Papa from 'papaparse';
import { TradingData } from '../types/trading';

export const loadCSVData = async (filePath: string): Promise<TradingData[]> => {
  try {
    const response = await fetch(filePath);
    const csvText = await response.text();
    
    return new Promise((resolve, reject) => {
      Papa.parse(csvText, {
        header: true,
        dynamicTyping: true,
        complete: (results) => {
          resolve(results.data as TradingData[]);
        },
        error: (error) => {
          reject(error);
        }
      });
    });
  } catch (error) {
    console.error('Error loading CSV data:', error);
    throw error;
  }
}; 