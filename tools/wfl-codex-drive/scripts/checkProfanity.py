#!/usr/bin/python

from profanity_check import predict, predict_prob
import sys


file = open("suspicious_texts.txt", "a")
source = open(sys.argv[1], "r")
lines = source.readlines()
for line in lines:
    print("Checking: "+str(line.rstrip()))
    prediction = predict_prob([line.rstrip()])
    if prediction[0] > 0.5:
      file.write(str(prediction[0]) + " - " + str(line.rstrip())+"\n")
      print("Offending line: "+str(line.rstrip()))

file.close()